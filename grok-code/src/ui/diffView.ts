import chalk from "chalk";

export function colorDiff(diff: string): string {
  return diff.split(/\r?\n/).map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return chalk.green(line);
    if (line.startsWith("-") && !line.startsWith("---")) return chalk.red(line);
    if (line.startsWith("@@")) return chalk.cyan(line);
    return line;
  }).join("\n");
}
