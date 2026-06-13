import { readFileSync, writeFileSync } from "node:fs";

/**
 * Convert a CC-CEDICT-style .u8 dictionary to CSV.
 *
 * .u8 line format: `Traditional Simplified [pinyin] /def1/def2/.../`
 * Comment lines start with `#` and are skipped.
 *
 * Output columns: word, translation, pronunciation (pinyin)
 *
 * Usage:
 *   npx tsx u8-to-csv.ts raw/cfdict.u8 --out=dictionaries/zh-fr.csv [--traditional] [--sep="; "]
 */

interface Options {
  input: string;
  out?: string;
  /** Use traditional chars as the word column instead of simplified. */
  traditional: boolean;
  /** Separator joining multiple definitions. */
  sep: string;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const opts: Options = { input: "", traditional: false, sep: "; " };

  for (const arg of argv) {
    if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg === "--traditional") opts.traditional = true;
    else if (arg.startsWith("--sep=")) opts.sep = arg.slice("--sep=".length);
    else positional.push(arg);
  }

  if (positional.length === 0) {
    throw new Error(
      "Usage: npx tsx u8-to-csv.ts <input.u8> --out=<file.csv> [--traditional] [--sep=\"; \"]",
    );
  }
  opts.input = positional[0];
  return opts;
}

// Matches: <trad> <simp> [<pinyin>] /<defs>/
const LINE_RE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/;

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function convert(opts: Options): void {
  const text = readFileSync(opts.input, "utf8");
  const lines = text.split(/\r?\n/);

  const rows: string[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith("#")) continue;

    const m = LINE_RE.exec(line);
    if (!m) {
      skipped++;
      continue;
    }

    const [, trad, simp, pinyin, defs] = m;
    const word = opts.traditional ? trad : simp;
    const translation = defs
      .split("/")
      .filter((d) => d.length > 0)
      .join(opts.sep);

    rows.push(
      [csvField(word), csvField(translation), csvField(pinyin)].join(","),
    );
    parsed++;
  }

  const output = rows.join("\n") + "\n";

  if (opts.out) {
    writeFileSync(opts.out, output, "utf8");
    console.error(`Wrote ${parsed} rows to ${opts.out} (${skipped} skipped).`);
  } else {
    process.stdout.write(output);
    console.error(`Converted ${parsed} rows (${skipped} skipped).`);
  }
}

convert(parseArgs(process.argv.slice(2)));
