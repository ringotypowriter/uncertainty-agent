# Atomic steps uncertainty testset (input-ready)

- Root: `input/atomic-steps-testset-input`
- Cases: 35

## Structure

Each case is a folder:

```
input/atomic-steps-testset-input/UA-001-.../
  procedure.md      # measurement scene + data (what happened)
  requirements.txt  # evaluation scope + required components + gold answer
```

## Run one case

Use `--input` to feed only the procedure file:

```bash
bun run start -- --input=input/atomic-steps-testset-input/UA-001-balance-tare/procedure.md
```

(`requirements.txt` stays out of the model context; you can use it for deterministic grading.)
