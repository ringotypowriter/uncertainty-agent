import fs from "node:fs/promises";
import path from "node:path";
import type { UncertaintyContext } from "./stages.js";

export class ContextManager {
  private ctx: UncertaintyContext = {};

  constructor(private contextPath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.contextPath, "utf-8");
      this.ctx = JSON.parse(raw);
    } catch {
      this.ctx = {};
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.contextPath), { recursive: true });
    await fs.writeFile(
      this.contextPath,
      JSON.stringify(this.ctx, null, 2),
      "utf-8",
    );
  }

  getField<F extends keyof UncertaintyContext>(
    field: F,
  ): UncertaintyContext[F] | undefined {
    return this.ctx[field];
  }

  setField<F extends keyof UncertaintyContext>(
    field: F,
    value: UncertaintyContext[F],
  ): void {
    this.ctx[field] = value;
  }

  getAll(): UncertaintyContext {
    return { ...this.ctx };
  }

  getAllJSON(): string {
    return JSON.stringify(this.ctx, null, 2);
  }
}
