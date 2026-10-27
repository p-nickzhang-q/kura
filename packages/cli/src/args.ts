import { AppError, EXIT } from "@kura/core";

export type ValueType = "string" | "boolean" | "number";

export interface ArgSpec {
  /** 选项名 (不带 --) 或位置参数名。 */
  name: string;
  type: ValueType;
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  /** 位置参数: 按顺序填充, 不出现在 --flag 形式里。 */
  positional?: boolean;
}

export interface ParsedArgs {
  options: Record<string, string | number | boolean>;
  positionals: Record<string, string>;
}

/**
 * 按命令自带的 spec 解析。不做通用 CLI 框架: spec 同时驱动解析、help 与 `schema` 输出,
 * 三处不可能漂移。新增参数只改 COMMANDS。
 */
export function parseArgs(argv: string[], specs: ArgSpec[]): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const options: Record<string, string | number | boolean> = {};
  const positionals: Record<string, string> = {};
  const positionalSpecs = specs.filter((s) => s.positional);
  let positionalIndex = 0;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      for (const rest of argv.slice(i + 1)) assignPositional(rest);
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
      const negated = name.startsWith("no-") && !byName.has(name) && byName.get(name.slice(3))?.type === "boolean";
      const spec = byName.get(negated ? name.slice(3) : name);

      if (!spec || spec.positional) {
        throw new AppError(`未知参数 --${name}`, EXIT.USAGE, { argument: name });
      }

      if (spec.type === "boolean") {
        options[spec.name] = negated ? false : coerce(inlineValue ?? "true", spec);
        continue;
      }
      const raw = inlineValue ?? argv[++i];
      if (raw === undefined) throw new AppError(`--${name} 缺少值`, EXIT.USAGE, { argument: name });
      options[spec.name] = coerce(raw, spec);
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      throw new AppError(`未知短参数 ${token}; 本项目只使用长参数`, EXIT.USAGE, { argument: token });
    }

    assignPositional(token);
  }

  for (const spec of specs) {
    if (spec.positional) continue;
    if (options[spec.name] === undefined && spec.default !== undefined) options[spec.name] = spec.default;
    if (spec.required && options[spec.name] === undefined) {
      throw new AppError(`缺少必需参数 --${spec.name}`, EXIT.USAGE, { argument: spec.name });
    }
  }
  for (const spec of positionalSpecs) {
    if (spec.required && positionals[spec.name] === undefined) {
      throw new AppError(`缺少必需参数 <${spec.name}>`, EXIT.USAGE, { argument: spec.name });
    }
  }

  return { options, positionals };

  function assignPositional(value: string): void {
    const spec = positionalSpecs[positionalIndex++];
    if (!spec) throw new AppError(`多余的参数: ${value}`, EXIT.USAGE, { argument: value });
    positionals[spec.name] = value;
  }
}

function coerce(raw: string, spec: ArgSpec): string | number | boolean {
  if (spec.type === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new AppError(`--${spec.name} 只接受 true/false`, EXIT.USAGE, { argument: spec.name });
  }
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new AppError(`--${spec.name} 需要数字`, EXIT.USAGE, { argument: spec.name });
    return n;
  }
  return raw;
}
