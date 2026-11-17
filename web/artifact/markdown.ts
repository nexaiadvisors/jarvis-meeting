/**
 * A small markdown parser for the doc page's preview. It returns plain data (blocks and
 * inline spans); the page renders that data as React elements. Nothing here or in the
 * renderer builds HTML from text, so a doc cannot inject markup or script into the page.
 * A link is kept only when it is http, https or mailto.
 *
 * Supported: # headings, paragraphs, - and 1. lists (with [ ] / [x] tasks), > quotes,
 * ``` code fences, --- rules, | pipe | tables, and inline **bold**, *italic*, `code`,
 * [text](url).
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'bold' | 'italic'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'link'; href: string; children: Inline[] }

export interface ListItem {
  /** undefined: a plain item. true/false: a task that is or is not done. */
  checked?: boolean
  children: Inline[]
}

export type Block =
  | { t: 'heading'; level: number; children: Inline[] }
  | { t: 'paragraph'; children: Inline[] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'quote'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'rule' }
  | { t: 'table'; header: Inline[][]; rows: Inline[][][] }

const SAFE_LINK = /^(https?:\/\/|mailto:)/i

/** Inline spans of one line. Unmatched markers stay as literal text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let plain = ''
  const flush = () => {
    if (plain !== '') out.push({ t: 'text', text: plain })
    plain = ''
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const code = /^`([^`]+)`/.exec(rest)
    if (code) {
      flush()
      out.push({ t: 'code', text: code[1] })
      i += code[0].length
      continue
    }
    const bold = /^\*\*([^*]+?)\*\*/.exec(rest)
    if (bold) {
      flush()
      out.push({ t: 'bold', children: parseInline(bold[1]) })
      i += bold[0].length
      continue
    }
    const italic = /^\*([^*\s][^*]*?)\*/.exec(rest)
    if (italic) {
      flush()
      out.push({ t: 'italic', children: parseInline(italic[1]) })
      i += italic[0].length
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)
    if (link) {
      flush()
      if (SAFE_LINK.test(link[2])) out.push({ t: 'link', href: link[2], children: parseInline(link[1]) })
      else out.push({ t: 'text', text: link[1] })
      i += link[0].length
      continue
    }
    plain += text[i]
    i += 1
  }
  flush()
  return out
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push({ t: 'code', text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ t: 'heading', level: heading[1].length, children: parseInline(heading[2].trim()) })
      i += 1
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ t: 'rule' })
      i += 1
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = tableCells(line).map(parseInline)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(tableCells(lines[i]).map(parseInline))
        i += 1
      }
      blocks.push({ t: 'table', header, rows })
      continue
    }
    const first = LIST_ITEM.exec(line)
    if (first) {
      const ordered = first[2] !== undefined
      const items: ListItem[] = []
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i])
        if (!item || (item[2] !== undefined) !== ordered) break
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(item[3])
        items.push(
          task ? { checked: task[1] !== ' ', children: parseInline(task[2]) } : { children: parseInline(item[3]) },
        )
        i += 1
      }
      blocks.push({ t: 'list', ordered, items })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push({ t: 'quote', children: parseInline(body.join(' ')) })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^\s*>/.test(lines[i])
    ) {
      para.push(lines[i].trim())
      i += 1
    }
    blocks.push({ t: 'paragraph', children: parseInline(para.join(' ')) })
  }
  return blocks
}
