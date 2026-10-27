import { AppError, EXIT, openRuntime, type Runtime } from "@kura/core";
import { parseArgs } from "./args";
import { GLOBAL_ARGS, findCommand, helpText, type Command } from "./commands";
import { Output } from "./output";
import { VERSION } from "./version";

/**
 * 入口只做四件事: 决定输出模式、解析、打开运行时、把错误映射成退出码。
 * 业务一律在 core; 这里出现业务分支就是分层漏了。
 */
const argv = process.argv.slice(2);

// 输出模式必须在解析之前确定: 解析失败时也得能用 JSON 报告错误。
const out = new Output(argv.includes("--json") || !process.stdout.isTTY ? "json" : "text", argv.includes("--stream"));

/** 注意: 不能在这里 process.exit, 否则 finally 不执行, 数据库不会 close。 */
async function main(): Promise<number> {
  let command: Command | null = null;
  let runtime: Runtime | null = null;

  try {
    if (argv.includes("--version")) {
      out.result("version", { version: VERSION }, () => `kura ${VERSION}`);
      return EXIT.OK;
    }

    const commandIndex = argv.findIndex((token) => !token.startsWith("-"));
    const commandName = commandIndex === -1 ? null : argv[commandIndex]!;

    if (!commandName || argv.includes("--help")) {
      process.stdout.write(`${helpText()}\n`);
      return EXIT.OK;
    }

    command = findCommand(commandName);

    const rest = [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];
    const parsed = parseArgs(rest, [...GLOBAL_ARGS, ...command.args]);
    if (parsed.options.help) {
      process.stdout.write(`${helpText()}\n`);
      return EXIT.OK;
    }

    if (command.needsDb) {
      const dataDir = typeof parsed.options["data-dir"] === "string" ? parsed.options["data-dir"] : undefined;
      runtime = await openRuntime({ dataDir });
    }

    const data = await command.run({ rt: runtime, out }, parsed);
    out.result(command.name, data, command.render);
    return EXIT.OK;
  } catch (err) {
    // 未预期异常也收敛成退出码, 不让 agent 看到裸栈 (栈只在 KURA_DEBUG 下进 stderr)。
    return out.fail(command?.name ?? null, err);
  } finally {
    runtime?.close();
  }
}

process.exit(await main());
