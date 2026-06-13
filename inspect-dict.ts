/**
 * Standalone exporter for Yomichan dictionary zips.
 *
 * Reads a dictionary file with the yomichan-dict-reader library and writes a
 * plain CSV: first column the character/term, second column its first meaning.
 *
 * Usage:
 *   npx tsx scripts/inspect-dict.ts <file.zip> [--type=term|kanji] [--count=N] [--out=path.csv]
 *
 * Examples:
 *   npx tsx scripts/inspect-dict.ts public/dictionaries/ZH-EN.zip --type=kanji --count=10
 *   npx tsx scripts/inspect-dict.ts public/dictionaries/FR-EN.zip --count=20 --out=fr.csv
 */
import fs from 'node:fs'
import path from 'node:path'
// CommonJS class: `module.exports = Yomichan`. Default import works under esModuleInterop.
import Yomichan from 'yomichan-dict-reader'
import * as OpenCC from 'opencc-js'

interface Args {
  file: string
  type: 'term' | 'kanji'
  count: number
  out: string
  simplified: boolean
  defLang?: string
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  let type: 'term' | 'kanji' = 'term'
  let count = 5
  let out = ''
  let simplified = false
  let defLang: string | undefined

  for (const arg of argv) {
    if (arg.startsWith('--type=')) {
      const v = arg.slice('--type='.length)
      if (v !== 'term' && v !== 'kanji') throw new Error(`--type must be 'term' or 'kanji', got '${v}'`)
      type = v
    } else if (arg.startsWith('--count=')) {
      const v = arg.slice('--count='.length)
      if (v === 'all') {
        count = Infinity
      } else {
        count = Number.parseInt(v, 10)
        if (!Number.isFinite(count) || count <= 0) throw new Error(`--count must be a positive integer or 'all'`)
      }
    } else if (arg === '--all') {
      count = Infinity
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length)
    } else if (arg.startsWith('--def-lang=')) {
      defLang = arg.slice('--def-lang='.length)
    } else if (arg === '--simplified') {
      simplified = true
    } else {
      positional.push(arg)
    }
  }

  const file = positional[0]
  if (!file) throw new Error('missing file argument. Usage: tsx scripts/inspect-dict.ts <file.zip> [--type=term|kanji] [--count=N] [--out=path.csv] [--simplified] [--def-lang=fr]')

  const resolved = path.resolve(file)
  if (!out) out = resolved.replace(/\.zip$/i, '') + '.csv'

  return { file: resolved, type, count, out: path.resolve(out), simplified, defLang }
}

/**
 * Build a "keep this term?" predicate. With --simplified, a term is dropped when
 * converting traditional->simplified changes it (i.e. it contained traditional
 * chars). Trad/simp share one Unicode block, so only a mapping table can tell
 * them apart — regex cannot.
 */
function makeKeepFilter(simplified: boolean): (term: string) => boolean {
  if (!simplified) return () => true
  const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' })
  return (term: string) => toSimplified(term) === term
}

/** Placeholder glosses that carry no meaning — drop the whole row. */
const PLACEHOLDER_MEANINGS = ["(Pas d'expression équivalente)"]
function isPlaceholderMeaning(meaning: string): boolean {
  return PLACEHOLDER_MEANINGS.some((p) => meaning.includes(p))
}

/** Quote a CSV field per RFC 4180 when it contains a comma, quote, or newline. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** A Yomichan structured-content node: text leaf, array, or a tag object. */
type SCNode = string | SCNode[] | { content?: SCNode; lang?: string; [k: string]: unknown }

/**
 * Collect text leaves from a structured-content tree. When `lang` is set, keep
 * only leaves in that language (inherited from the nearest ancestor that
 * declares one); otherwise keep every leaf. Ported from the server service.
 */
function collectText(node: SCNode, lang: string | undefined, inherited?: string): string[] {
  if (typeof node === 'string') {
    if (!lang || inherited === lang) return [node]
    return []
  }
  if (Array.isArray(node)) return node.flatMap((n) => collectText(n, lang, inherited))
  if (node && typeof node === 'object') {
    const next = typeof node.lang === 'string' ? node.lang : inherited
    return node.content ? collectText(node.content, lang, next) : []
  }
  return []
}

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(?:quot|apos|#39|amp|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

/**
 * Part-of-speech tags this dictionary prepends on their own line before each
 * gloss, e.g. "noun\narchitect". We strip these to surface the translation.
 */
const POS_TAGS = new Set([
  'noun', 'name', 'verb', 'adj', 'adjective', 'adv', 'adverb', 'pron', 'pronoun',
  'prep', 'preposition', 'conj', 'conjunction', 'interj', 'interjection', 'num',
  'numeral', 'det', 'determiner', 'particle', 'article', 'abbr', 'suffix',
  'prefix', 'expr', 'phrase', 'proverb', 'contraction', 'symbol', 'letter',
])

/**
 * This dictionary stores a gloss as one string of alternating "POS\ngloss"
 * lines. Return the first real gloss line, skipping the POS tags. Collapses to
 * a single line so it doesn't break the CSV row.
 */
function firstGlossFromString(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  const gloss = lines.find((l) => !POS_TAGS.has(l.toLowerCase()))
  return gloss ?? lines[0] ?? ''
}

/**
 * Pull a plain-text first meaning from a Yomichan definition. Handles plain
 * strings and structured-content trees; with `defLang` keeps only that
 * language's leaves (falls back to all if the filter matched nothing).
 */
function firstMeaning(def: unknown, defLang?: string): string {
  if (typeof def === 'string') return decodeEntities(firstGlossFromString(def))
  if (def && typeof def === 'object' && (def as { type?: string }).type === 'structured-content') {
    const content = (def as { content?: SCNode }).content
    if (!content) return ''
    let leaves = collectText(content, defLang)
    if (defLang && leaves.length === 0) leaves = collectText(content, undefined)
    // Skip list-numbering leaves like "1. " — we want the first real gloss.
    const first = leaves.map((s) => s.trim()).find((s) => s && !/^\d+\.$/.test(s))
    return first ? decodeEntities(first) : ''
  }
  return ''
}

async function main() {
  const { file, type, count, out, simplified, defLang } = parseArgs(process.argv.slice(2))
  const yomichan = new Yomichan()
  const keep = makeKeepFilter(simplified)
  const rows: [string, string][] = []

  if (type === 'kanji') {
    await yomichan.readKanjiDictionary(file)
    // kanjiData[file] is keyed by character; each value is an array of entries.
    const data = (yomichan.kanjiData[file] ?? {}) as Record<string, { meaningsArr?: string[] }[]>
    for (const [char, list] of Object.entries(data)) {
      if (rows.length >= count) break
      if (!keep(char)) continue
      const meaning = list[0]?.meaningsArr?.[0] ?? ''
      if (isPlaceholderMeaning(meaning)) continue
      rows.push([char, meaning])
    }
  } else {
    await yomichan.readDictionary(file)
    // allDicts[file] is keyed by "term,reading"; each value is an array of entries.
    const data = await yomichan.getAllEntriesFromDict(file)
    for (const list of Object.values(data) as { term: string; definitions: unknown[] }[][]) {
      if (rows.length >= count) break
      const entry = list[0]
      if (!entry || !keep(entry.term)) continue
      const meaning = firstMeaning(entry.definitions[0], defLang)
      if (isPlaceholderMeaning(meaning)) continue
      rows.push([entry.term, meaning])
    }
  }

  const csv = rows.map(([a, b]) => `${csvField(a)},${csvField(b)}`).join('\n') + '\n'
  fs.writeFileSync(out, csv, 'utf8')
  console.log(`Wrote ${rows.length} rows to ${out}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
