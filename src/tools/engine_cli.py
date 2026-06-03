#!/usr/bin/env python3
"""
CLI dispatcher for uncertainty computation engine tools.

Each tool accepts JSON on stdin or command-line args and outputs JSON to stdout.
This clean interface is designed to be called from Node.js via subprocess.

Usage:
  python3 engine_cli.py --tool <tool_name> [args...]

Tools:
  parse_model          Parse equation string into structured model
  compute_sensitivity  Compute partial derivative / sensitivity coefficient
  statistics           Compute descriptive statistics (mean, std, RSD, SE)
  propagate            Run GUM uncertainty propagation
  coverage_factor      Convert degrees of freedom to coverage factor k
  evaluate             Evaluate a mathematical expression (sympy fallback)
"""

import json
import math
import sys
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import sympy as sp
# ── Inlined from uncertainty_computation_engine ──

def _parse_equation(equation: str):
    """Parse "y = f(x1, x2, ...)" into (output_var, sympy_expr, input_var_set)."""
    eq_str = equation.strip()
    if "=" not in eq_str:
        raise ValueError(f"方程必须包含 '='，当前: {eq_str}")
    lhs, rhs = eq_str.split("=", 1)
    output_var = lhs.strip()
    if not output_var:
        raise ValueError("方程左侧输出变量为空")
    rhs_clean = rhs.strip()
    rhs_clean = re.sub(r"(\d+\.?\d*)e([+-]?\d+)", r"(\1*10**\2)", rhs_clean)
    tokens = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", rhs_clean))
    reserved = {"e", "E", "pi", "sin", "cos", "tan", "log", "ln", "exp", "sqrt"}
    var_names = sorted(tokens - reserved)
    symbols = {name: sp.symbols(name) for name in var_names}
    sympy_expr = sp.parse_expr(rhs_clean, local_dict=symbols, evaluate=False)
    return output_var, sympy_expr, set(var_names)

def _evaluate_expr(expr, values: dict) -> float:
    """Evaluate a sympy expression at given numeric point."""
    subs = {sp.symbols(k): v for k, v in values.items() if k in [str(s) for s in expr.free_symbols]}
    return float(expr.evalf(subs=subs))

def _compute_partial_derivative(expr, var_name: str, values: dict) -> float:
    """Compute ∂f/∂x_i at a point."""
    var = sp.symbols(var_name)
    if var not in expr.free_symbols:
        return 0.0
    derivative = sp.diff(expr, var)
    return _evaluate_expr(derivative, values)

def _effective_dof(uc: float, components: list) -> float:
    """Welch-Satterthwaite: ν_eff = u_c⁴ / Σ(u_i⁴ / ν_i)."""
    numerator = uc ** 4
    denominator = 0.0
    for comp in components:
        nu = comp.get("dof", math.inf)
        if nu is None or nu == math.inf or nu <= 0:
            continue
        ui = comp.get("u_eff", 0.0)
        denominator += (ui ** 4) / nu
    return math.inf if denominator == 0 else numerator / denominator
def _coverage_factor_from_dof(dof: float, confidence: float = 0.95) -> float:
    """t-distribution coverage factor from ν_eff. Lazily imports scipy."""
    # Lazy import — scipy is heavy, only load when this tool is called
    try:
        from scipy import stats as _scipy_stats
        _has_scipy = True
    except ImportError:
        _has_scipy = False

    if dof == math.inf or dof > 1e6:
        return float(_scipy_stats.norm.ppf(1 - (1 - confidence) / 2)) if _has_scipy else 1.96
    if not _has_scipy:
        table = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57,
                 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23,
                 15: 2.13, 20: 2.09, 30: 2.04, 50: 2.01, 100: 1.98}
        keys = sorted(table.keys())
        for k in keys:
            if dof <= k:
                return table[k]
        return 1.96
    return float(_scipy_stats.t.ppf(1 - (1 - confidence) / 2, df=dof))

def tool_parse_model(equation: str) -> dict:
    """Parse a measurement equation into a structured model object."""
    try:
        output_var, expr, input_vars = _parse_equation(equation)
        return {
            "ok": True,
            "output_var": output_var,
            "input_vars": sorted(input_vars),
            "expr": str(expr),
            "latex": sp.latex(expr),
        }
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
        }


# ---- Tool: compute_sensitivity ----

def tool_compute_sensitivity(
    equation: str,
    variable: str,
    point: dict,
    measurand_value: float = None,
) -> dict:
    """Compute sensitivity coefficient c_i = ∂f/∂x_i for a single variable.
    
    If measurand_value is provided and differs from the equation's output at the
    evaluation point by a factor > 1.01, auto-scale the sensitivity to match the
    declared measurand unit. This corrects for equations that compute a fractional
    value when the measurand is declared in percent.
    """
    try:
        output_var, expr, input_vars = _parse_equation(equation)
        if variable not in input_vars:
            return {
                "ok": False,
                "error": f"Variable '{variable}' not found in equation. Available: {sorted(input_vars)}",
            }
        c_i = _compute_partial_derivative(expr, variable, point)
        y = _evaluate_expr(expr, point)
        x_i = point.get(variable, 0)
        
        # Auto-detect unit scale mismatch and correct
        scale = 1.0
        if measurand_value is not None and y != 0:
            ratio = abs(measurand_value / y)
            if ratio > 1.01:
                scale = measurand_value / y
        
        c_i_scaled = c_i * scale
        y_scaled = y * scale
        rel_sens = (c_i_scaled * x_i / y_scaled) if y_scaled != 0 else None
        return {
            "ok": True,
            "variable": variable,
            "sensitivity": round(c_i_scaled, 12),
            "relative_sensitivity": round(rel_sens, 12) if rel_sens is not None else None,
            "output_value_at_point": round(y_scaled, 12),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---- Tool: statistics ----

def tool_statistics(data: List[float]) -> dict:
    """Compute descriptive statistics for A-type evaluation."""
    try:
        n = len(data)
        if n < 2:
            return {"ok": False, "error": f"Need at least 2 observations, got {n}"}
        mean = sum(data) / n
        variance = sum((x - mean) ** 2 for x in data) / (n - 1)
        std = math.sqrt(variance)
        rsd = std / abs(mean) if mean != 0 else float("inf")
        se = std / math.sqrt(n)  # standard error = A-type standard uncertainty
        if n <= 30:
            # Pooled historical data correction for small n (ISO 11352)
            dof = n - 1
        else:
            dof = n - 1
        return {
            "ok": True,
            "n": n,
            "mean": round(mean, 12),
            "std": round(std, 12),
            "rsd": round(rsd, 12),
            "se": round(se, 12),        # A-type standard uncertainty
            "dof": dof,
            "min": min(data),
            "max": max(data),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---- Tool: propagate ----
def tool_propagate(
    equation: str,
    point: dict,
    components: List[dict],
    correlation: Optional[List[dict]] = None,
    measurand_value: float = None,
    correlation_strategy: str = "correlated",
) -> dict:
    """
    Run GUM uncertainty propagation.

    Each component dict (standard flat mode):
      - name: str
      - u: float (standard uncertainty value)
      - type: "absolute" | "relative"
      - variable: str (target input variable)
      - dof: int | null (degrees of freedom, for A-type)

    correlation_strategy:
      - "correlated": algebraic sum within each source, RSS across sources (default).
      - "independent": each per-variable contribution RSS'd individually (r=0 for all pairs).

    If measurand_value is provided and differs from y_best by >1%,
    auto-scale u_eff and uc to match the declared measurand unit.
    """
    try:
        output_var, expr, input_vars = _parse_equation(equation)

        # Auto-detect unit scale mismatch
        y_best = _evaluate_expr(expr, point)
        scale = 1.0
        if measurand_value is not None and y_best != 0:
            ratio = abs(measurand_value / y_best)
            if ratio > 1.01:
                scale = measurand_value / y_best

        # ---- independent mode: flatten per_variable_contributions to independent components ----
        if correlation_strategy == "independent" and components:
            flat: List[dict] = []
            for comp in components:
                pvcs = comp.get("per_variable_contributions")
                if pvcs and isinstance(pvcs, list):
                    for pvc in pvcs:
                        flat.append({
                            "name": f"{comp.get('name','?')} [{pvc.get('variable','?')}]",
                            "u_abs": abs(float(pvc["contribution"])) * scale,
                            "dof": comp.get("dof"),
                        })
                else:
                    u_val = float(comp.get("u", 0))
                    u_type = comp.get("type", "absolute")
                    var = comp.get("variable")
                    abs_u = u_val * abs(float(point[var])) if u_type == "relative" and var and var in point else u_val
                    flat.append({
                        "name": comp.get("name", "?"),
                        "u_abs": abs_u * scale,
                        "dof": comp.get("dof"),
                    })
            components = flat

        # Expand relative components to absolute (standard path)
        expanded_components = []
        for comp in components:
            if "u_abs" in comp:
                expanded_components.append({
                    "name": comp.get("name", "?"),
                    "u_abs": round(comp["u_abs"], 12),
                    "u_rel": comp.get("u", comp.get("u_abs", 0)),
                    "type": "absolute",
                    "variable": comp.get("variable"),
                    "dof": comp.get("dof"),
                })
                continue

            u_val = float(comp["u"])
            u_type = comp.get("type", "absolute")
            var = comp.get("variable")
            dof = comp.get("dof")

            if u_type == "relative" and var and var in point:
                abs_u = u_val * abs(float(point[var]))
            elif u_type == "absolute":
                abs_u = u_val
            else:
                return {
                    "ok": False,
                    "error": f"Cannot resolve absolute uncertainty for component '{comp.get('name','?')}': type={u_type}, variable={var}, point={point}"
                }

            expanded_components.append({
                "name": comp.get("name", "?"),
                "u_abs": round(abs_u, 12),
                "u_rel": u_val,
                "type": u_type,
                "variable": var,
                "dof": dof if dof is not None else None,
            })

        # Compute sensitivities for each input variable
        sensitivities = {}
        for var in input_vars:
            c_i = _compute_partial_derivative(expr, var, point)
            sensitivities[var] = c_i

        # Compute contributions
        uc_sq = 0.0
        contributions = []
        is_independent = correlation_strategy == "independent"
        for comp in expanded_components:
            var = comp.get("variable")
            if is_independent and "u_abs" in comp:
                u_eff = comp["u_abs"]
                c_i = 1.0
            else:
                c_i = (sensitivities.get(var, 1.0) if var else 1.0) * scale
                u_eff = c_i * comp["u_abs"]
            uc_sq += u_eff ** 2
            contributions.append({
                "name": comp["name"],
                "variable": var,
                "sensitivity_coefficient": c_i,
                "u_abs": comp.get("u_abs", 0),
                "u_eff": u_eff,
                "percent_of_uc2": 0.0,
                "dof": comp["dof"],
            })

        # ---- correlation: add covariance terms for specified variable pairs (§6.3.2) ----
        cov_contribs = []
        if correlation:
            for pair in correlation:
                var1 = pair.get("var1", "")
                var2 = pair.get("var2", "")
                r_val = float(pair.get("r", 0))
                u1, u2 = 0.0, 0.0
                for c in contributions:
                    if c.get("variable") == var1:
                        u1 = c["u_eff"]
                    if c.get("variable") == var2:
                        u2 = c["u_eff"]
                cov = 2.0 * u1 * u2 * r_val
                uc_sq += cov
                cov_contribs.append({"var1": var1, "var2": var2, "r": r_val, "covariance_term": round(cov, 12)})

        uc = math.sqrt(max(0, uc_sq))
        y_scaled = y_best * scale

        if uc_sq > 0:
            for c in contributions:
                c["percent_of_uc2"] = round(100.0 * c["u_eff"] ** 2 / uc_sq, 2)

        nu_eff = math.inf
        dof_sum = 0.0
        for c in contributions:
            if c["dof"] and c["dof"] > 0:
                dof_sum += (c["u_eff"] ** 4) / c["dof"]
        if dof_sum > 0 and uc > 0:
            nu_eff = uc ** 4 / dof_sum

        return {
            "ok": True,
            "combined_standard_uncertainty": round(uc, 12),
            "relative_standard_uncertainty": round(uc / y_scaled, 12) if y_scaled != 0 else None,
            "output_value": round(y_scaled, 12),
            "effective_dof": round(nu_eff, 6) if nu_eff != math.inf else None,
            "components": contributions,
            "covariance_terms": cov_contribs if cov_contribs else None,
            "correlation_strategy_used": correlation_strategy,
        }
    except Exception as e:

        return {"ok": False, "error": str(e)}


# ---- Tool: coverage_factor ----

def tool_coverage_factor(dof: float, confidence: float = 0.95) -> dict:
    """Compute coverage factor k from degrees of freedom."""
    try:
        k = _coverage_factor_from_dof(dof, confidence)
        return {
            "ok": True,
            "dof": dof,
            "confidence": confidence,
            "k": round(k, 6),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---- Tool: evaluate ----

def tool_evaluate(expression: str, variables: Optional[dict] = None) -> dict:
    """
    Evaluate a mathematical expression using sympy.
    This is the fallback tool for edge cases not covered by specialized tools.
    """
    try:
        # Clean scientific notation
        cleaned = re.sub(r"(\d+\.?\d*)[eE]([+\-]?\d+)", r"(\1*10**\2)", expression)

        # Resolve variables
        local_dict = {}
        if variables:
            for k, v in variables.items():
                local_dict[k] = sp.symbols(k)

        expr = sp.parse_expr(cleaned, local_dict=local_dict, evaluate=False)

        if variables:
            subs = {}
            for k, v in variables.items():
                if isinstance(v, (int, float)):
                    subs[sp.symbols(k)] = v
            result = float(expr.evalf(subs=subs))
        else:
            result = float(expr.evalf())

        return {
            "ok": True,
            "value": round(result, 12) if result == result else None,
            "is_infinite": result == float("inf") or result == float("-inf"),
            "is_nan": result != result,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---- CLI dispatcher ----

TOOLS = {
    "parse_model": {
        "fn": tool_parse_model,
        "args": {"equation": str},
    },
    "compute_sensitivity": {
        "fn": tool_compute_sensitivity,
        "args": {"equation": str, "variable": str, "point": json.loads},
        "optional_args": {"measurand_value": float},
    },
    "statistics": {
        "fn": tool_statistics,
        "args": {"data": json.loads},
    },
    "propagate": {
        "fn": tool_propagate,
        "args": {
            "equation": str,
            "point": json.loads,
            "components": json.loads,
        },
        "optional_args": {
            "correlation": json.loads,
            "measurand_value": float,
            "correlation_strategy": str,
        },
    },
    "coverage_factor": {
        "fn": tool_coverage_factor,
        "args": {"dof": float},
        "optional_args": {"confidence": float},
    },
    "evaluate": {
        "fn": tool_evaluate,
        "args": {"expression": str},
        "optional_args": {"variables": json.loads},
    },
}


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Uncertainty Engine CLI")
    parser.add_argument("--tool", required=True, choices=list(TOOLS.keys()),
                        help="Tool to run")
    parser.add_argument("--args", default="{}",
                        help="JSON object with tool arguments")

    args = parser.parse_args()
    tool_info = TOOLS[args.tool]
    tool_args = json.loads(args.args)

    # Build kwargs
    kwargs = {}
    for arg_name, converter in tool_info.get("args", {}).items():
        if arg_name in tool_args:
            kwargs[arg_name] = tool_args[arg_name]
        else:
            print(json.dumps({"ok": False, "error": f"Missing required argument: {arg_name}"}))
            sys.exit(1)

    for arg_name, converter in tool_info.get("optional_args", {}).items():
        if arg_name in tool_args:
            kwargs[arg_name] = tool_args[arg_name]

    result = tool_info["fn"](**kwargs)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
