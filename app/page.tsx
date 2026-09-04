'use client';

import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import { useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  FileJson,
  FileText,
  ListTree,
  Maximize2,
  Minimize2,
  Search,
  Upload,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type JsonType =
  | 'document'
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null';

type SourcePosition = {
  index: number;
  line: number;
  column: number;
};

type JsonNode = {
  id: string;
  type: JsonType;
  label: string;
  key: string | number | null;
  path: string;
  depth: number;
  start: SourcePosition;
  end: SourcePosition;
  startIndex: number;
  endIndex: number;
  value: unknown;
  children: JsonNode[];
};

type ParseStats = {
  roots: number;
  nodes: number;
  objects: number;
  arrays: number;
  values: number;
  maxDepth: number;
  bytes: number;
  lines: number;
};

type ParseSuccess = {
  ok: true;
  root: JsonNode;
  stats: ParseStats;
  mode: 'single' | 'stream';
  source: string;
};

type ParseFailure = {
  ok: false;
  message: string;
  line: number;
  column: number;
  excerpt: string;
  pointer: string;
};

type ParseOutcome = ParseSuccess | ParseFailure;

type PaneId = 'left' | 'right';

const APP_VERSION = '1.0.0';
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_SITE_BASE_PATH ?? '';

const publicAsset = (path: string) => `${PUBLIC_BASE_PATH}${path}`;

const SAMPLE_JSON = `{
  "project": "Desirializer demo",
  "version": 1,
  "request": {
    "source": "upload or paste",
    "acceptedFiles": [".json", ".txt"],
    "strictJson": true
  },
  "records": [
    {
      "id": "usr_101",
      "profile": {
        "name": "Ada",
        "active": true,
        "roles": ["admin", "reviewer"]
      }
    },
    {
      "id": "usr_102",
      "profile": {
        "name": "Grace",
        "active": false,
        "roles": ["reader"]
      }
    }
  ],
  "meta": null
}`;

const COMPARE_SAMPLE_JSON = `{
  "project": "Desirializer demo",
  "version": 2,
  "request": {
    "source": "compare pane",
    "acceptedFiles": [".json", ".txt"],
    "strictJson": true
  },
  "records": [
    {
      "id": "usr_101",
      "profile": {
        "name": "Ada",
        "active": true,
        "roles": ["admin", "reviewer", "owner"]
      }
    },
    {
      "id": "usr_103",
      "profile": {
        "name": "Lin",
        "active": true,
        "roles": ["reader"]
      }
    }
  ],
  "meta": {
    "changed": true
  }
}`;

function buildLineStarts(source: string) {
  const starts = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      starts.push(index + 1);
    }
  }

  return starts;
}

function positionAt(index: number, lineStarts: number[]): SourcePosition {
  const safeIndex = Math.max(0, index);
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (lineStarts[middle] <= safeIndex) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const lineIndex = Math.max(0, high);

  return {
    index: safeIndex,
    line: lineIndex + 1,
    column: safeIndex - lineStarts[lineIndex] + 1,
  };
}

function formatPathSegment(key: string | number) {
  if (typeof key === 'number') {
    return `[${key}]`;
  }

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return `.${key}`;
  }

  return `[${JSON.stringify(key)}]`;
}

function appendPath(base: string, key: string | number) {
  return `${base}${formatPathSegment(key)}`;
}

function lineLabel(position: SourcePosition) {
  return `${position.line}:${position.column}`;
}

class JsonSyntaxError extends Error {
  index: number;

  constructor(message: string, index: number) {
    super(message);
    this.index = index;
  }
}

class JsonPositionParser {
  private source: string;
  private index = 0;
  private lineStarts: number[];
  private nextId = 1;

  constructor(source: string) {
    this.source = source;
    this.lineStarts = buildLineStarts(source);
  }

  parse(): { root: JsonNode; mode: 'single' | 'stream'; roots: number } {
    const documents: JsonNode[] = [];
    const values: unknown[] = [];

    this.skipWhitespace();

    while (!this.isEnd()) {
      const documentIndex = documents.length;
      const node = this.parseValue(
        `$[${documentIndex}]`,
        `Document ${documentIndex + 1}`,
        1,
        documentIndex,
      );

      documents.push(node);
      values.push(node.value);
      this.skipWhitespace();

      if (this.isEnd()) {
        break;
      }

      if (this.peek() === ',') {
        this.index += 1;
        this.skipWhitespace();

        if (this.isEnd()) {
          this.fail('Expected another JSON value after the comma.');
        }

        continue;
      }

      if (this.isValueStart(this.peek())) {
        continue;
      }

      this.fail('Expected the next JSON value or the end of the file.');
    }

    if (documents.length === 0) {
      this.fail('Paste JSON or upload a file to begin.');
    }

    if (documents.length === 1) {
      return {
        root: rebaseNode(documents[0], '$', 'root', 0),
        mode: 'single',
        roots: 1,
      };
    }

    const first = documents[0];
    const last = documents[documents.length - 1];

    return {
      root: {
        id: 'node-stream-root',
        type: 'document',
        label: 'document stream',
        key: null,
        path: '$',
        depth: 0,
        start: first.start,
        end: last.end,
        startIndex: first.startIndex,
        endIndex: last.endIndex,
        value: values,
        children: documents,
      },
      mode: 'stream',
      roots: documents.length,
    };
  }

  private parseValue(
    path: string,
    label: string,
    depth: number,
    key: string | number | null,
  ): JsonNode {
    this.skipWhitespace();

    if (this.isEnd()) {
      this.fail('Expected a JSON value.');
    }

    const character = this.peek();

    if (character === '{') {
      return this.parseObject(path, label, depth, key);
    }

    if (character === '[') {
      return this.parseArray(path, label, depth, key);
    }

    if (character === '"') {
      return this.parseStringNode(path, label, depth, key);
    }

    if (character === '-' || this.isDigit(character)) {
      return this.parseNumber(path, label, depth, key);
    }

    if (this.source.startsWith('true', this.index)) {
      return this.parseLiteral(path, label, depth, key, 'boolean', true, 4);
    }

    if (this.source.startsWith('false', this.index)) {
      return this.parseLiteral(path, label, depth, key, 'boolean', false, 5);
    }

    if (this.source.startsWith('null', this.index)) {
      return this.parseLiteral(path, label, depth, key, 'null', null, 4);
    }

    this.fail(`Unexpected token ${JSON.stringify(character)}.`);
  }

  private parseObject(
    path: string,
    label: string,
    depth: number,
    key: string | number | null,
  ): JsonNode {
    const id = this.createId();
    const startIndex = this.index;
    const children: JsonNode[] = [];
    const value: Record<string, unknown> = {};

    this.index += 1;
    this.skipWhitespace();

    if (this.peek() === '}') {
      this.index += 1;
      return this.createNode(
        id,
        'object',
        label,
        key,
        path,
        depth,
        startIndex,
        this.index,
        value,
        children,
      );
    }

    while (!this.isEnd()) {
      this.skipWhitespace();

      if (this.peek() !== '"') {
        this.fail('Expected a quoted object key.');
      }

      const property = this.parseStringToken();
      this.skipWhitespace();
      this.expect(':', 'Expected a colon after the object key.');

      const child = this.parseValue(
        appendPath(path, property.value),
        property.value,
        depth + 1,
        property.value,
      );

      children.push(child);
      value[property.value] = child.value;
      this.skipWhitespace();

      if (this.peek() === '}') {
        this.index += 1;
        return this.createNode(
          id,
          'object',
          label,
          key,
          path,
          depth,
          startIndex,
          this.index,
          value,
          children,
        );
      }

      this.expect(',', 'Expected a comma or a closing brace.');
      this.skipWhitespace();

      if (this.peek() === '}') {
        this.fail('Trailing commas are not valid JSON.');
      }
    }

    this.fail('Unterminated object.');
  }

  private parseArray(
    path: string,
    label: string,
    depth: number,
    key: string | number | null,
  ): JsonNode {
    const id = this.createId();
    const startIndex = this.index;
    const children: JsonNode[] = [];
    const value: unknown[] = [];

    this.index += 1;
    this.skipWhitespace();

    if (this.peek() === ']') {
      this.index += 1;
      return this.createNode(
        id,
        'array',
        label,
        key,
        path,
        depth,
        startIndex,
        this.index,
        value,
        children,
      );
    }

    while (!this.isEnd()) {
      const itemIndex = children.length;
      const child = this.parseValue(
        appendPath(path, itemIndex),
        `[${itemIndex}]`,
        depth + 1,
        itemIndex,
      );

      children.push(child);
      value.push(child.value);
      this.skipWhitespace();

      if (this.peek() === ']') {
        this.index += 1;
        return this.createNode(
          id,
          'array',
          label,
          key,
          path,
          depth,
          startIndex,
          this.index,
          value,
          children,
        );
      }

      this.expect(',', 'Expected a comma or a closing bracket.');
      this.skipWhitespace();

      if (this.peek() === ']') {
        this.fail('Trailing commas are not valid JSON.');
      }
    }

    this.fail('Unterminated array.');
  }

  private parseStringNode(
    path: string,
    label: string,
    depth: number,
    key: string | number | null,
  ): JsonNode {
    const id = this.createId();
    const token = this.parseStringToken();

    return this.createNode(
      id,
      'string',
      label,
      key,
      path,
      depth,
      token.start,
      token.end,
      token.value,
      [],
    );
  }

  private parseStringToken() {
    const start = this.index;

    this.expect('"', 'Expected a string.');

    while (!this.isEnd()) {
      const character = this.peek();

      if (character === '"') {
        this.index += 1;

        try {
          return {
            value: JSON.parse(this.source.slice(start, this.index)) as string,
            start,
            end: this.index,
          };
        } catch {
          this.fail('Invalid string escape sequence.', start);
        }
      }

      if (character === '\\') {
        this.index += 1;

        if (this.isEnd()) {
          this.fail('Unterminated string escape.');
        }

        const escape = this.peek();

        if (escape === 'u') {
          this.index += 1;

          for (let offset = 0; offset < 4; offset += 1) {
            if (!this.isHex(this.peek())) {
              this.fail('Expected four hexadecimal digits after \\u.');
            }

            this.index += 1;
          }
        } else if ('"\\/bfnrt'.includes(escape)) {
          this.index += 1;
        } else {
          this.fail(`Invalid string escape ${JSON.stringify(escape)}.`);
        }

        continue;
      }

      if (character.charCodeAt(0) < 0x20) {
        this.fail('Strings cannot contain raw control characters.');
      }

      this.index += 1;
    }

    this.fail('Unterminated string.');
  }

  private parseNumber(
    path: string,
    label: string,
    depth: number,
    key: string | number | null,
  ): JsonNode {
    const id = this.createId();
    const startIndex = this.index;

    if (this.peek() === '-') {
      this.index += 1;
    }

    if (this.peek() === '0') {
      this.index += 1;

      if (this.isDigit(this.peek())) {
        this.fail('Numbers cannot use leading zeroes.', this.index);
      }
    } else if (this.isDigitOneToNine(this.peek())) {
      while (this.isDigit(this.peek())) {
        this.index += 1;
      }
    } else {
      this.fail('Expected a digit in the number.');
    }

    if (this.peek() === '.') {
      this.index += 1;

      if (!this.isDigit(this.peek())) {
        this.fail('Expected a digit after the decimal point.');
      }

      while (this.isDigit(this.peek())) {
        this.index += 1;
      }
    }

    if (this.peek() === 'e' || this.peek() === 'E') {
      this.index += 1;

      if (this.peek() === '+' || this.peek() === '-') {
        this.index += 1;
      }

      if (!this.isDigit(this.peek())) {
        this.fail('Expected a digit in the exponent.');
      }

      while (this.isDigit(this.peek())) {
        this.index += 1;
      }
    }

    const raw = this.source.slice(startIndex, this.index);
    const value = JSON.parse(raw) as number;

    return this.createNode(
      id,
      'number',
      label,
      key,
      path,
      depth,
      startIndex,
      this.index,
      value,
      [],
    );
  }

  private parseLiteral(
    path: string,
    label: string,
    depth: number,
    key: string | number | null,
    type: 'boolean' | 'null',
    value: boolean | null,
    length: number,
  ): JsonNode {
    const id = this.createId();
    const startIndex = this.index;

    this.index += length;

    return this.createNode(
      id,
      type,
      label,
      key,
      path,
      depth,
      startIndex,
      this.index,
      value,
      [],
    );
  }

  private createNode(
    id: string,
    type: JsonType,
    label: string,
    key: string | number | null,
    path: string,
    depth: number,
    startIndex: number,
    endIndex: number,
    value: unknown,
    children: JsonNode[],
  ): JsonNode {
    return {
      id,
      type,
      label,
      key,
      path,
      depth,
      start: positionAt(startIndex, this.lineStarts),
      end: positionAt(Math.max(startIndex, endIndex - 1), this.lineStarts),
      startIndex,
      endIndex,
      value,
      children,
    };
  }

  private skipWhitespace() {
    while (
      !this.isEnd() &&
      [' ', '\n', '\r', '\t', '\uFEFF'].includes(this.peek())
    ) {
      this.index += 1;
    }
  }

  private expect(character: string, message: string) {
    if (this.peek() !== character) {
      this.fail(message);
    }

    this.index += 1;
  }

  private createId() {
    const id = `node-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private isEnd() {
    return this.index >= this.source.length;
  }

  private peek() {
    return this.source[this.index] ?? '';
  }

  private isValueStart(character: string) {
    return (
      character === '{' ||
      character === '[' ||
      character === '"' ||
      character === '-' ||
      character === 't' ||
      character === 'f' ||
      character === 'n' ||
      this.isDigit(character)
    );
  }

  private isDigit(character: string) {
    return character >= '0' && character <= '9';
  }

  private isDigitOneToNine(character: string) {
    return character >= '1' && character <= '9';
  }

  private isHex(character: string) {
    return /^[0-9a-fA-F]$/.test(character);
  }

  private fail(message: string, index = this.index): never {
    throw new JsonSyntaxError(message, index);
  }
}

function rebaseNode(
  node: JsonNode,
  path: string,
  label: string,
  depth: number,
): JsonNode {
  const children = node.children.map((child) =>
    rebaseNode(
      child,
      appendPath(path, child.key ?? child.label),
      child.label,
      depth + 1,
    ),
  );

  return {
    ...node,
    path,
    label,
    depth,
    children,
  };
}

function makeExcerpt(source: string, index: number) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const nextBreak = source.indexOf('\n', index);
  const lineEnd = nextBreak === -1 ? source.length : nextBreak;
  const excerpt = source.slice(lineStart, lineEnd).replace(/\t/g, ' ');
  const pointerOffset = Math.max(0, index - lineStart);

  return {
    excerpt: excerpt || '(blank line)',
    pointer: `${' '.repeat(pointerOffset)}^`,
  };
}

function parseJsonInput(source: string): ParseOutcome {
  const lineStarts = buildLineStarts(source);
  const parser = new JsonPositionParser(source);

  try {
    const parsed = parser.parse();
    const stats = collectStats(parsed.root, parsed.roots, source);

    return {
      ok: true,
      root: parsed.root,
      stats,
      mode: parsed.mode,
      source,
    };
  } catch (error) {
    const syntaxError =
      error instanceof JsonSyntaxError
        ? error
        : new JsonSyntaxError('Unable to parse the JSON input.', 0);
    const position = positionAt(syntaxError.index, lineStarts);
    const excerpt = makeExcerpt(source, syntaxError.index);

    return {
      ok: false,
      message: syntaxError.message,
      line: position.line,
      column: position.column,
      excerpt: excerpt.excerpt,
      pointer: excerpt.pointer,
    };
  }
}

function collectStats(
  root: JsonNode,
  roots: number,
  source: string,
): ParseStats {
  const stats: ParseStats = {
    roots,
    nodes: 0,
    objects: 0,
    arrays: 0,
    values: 0,
    maxDepth: 0,
    bytes: new Blob([source]).size,
    lines: Math.max(1, buildLineStarts(source).length),
  };

  function visit(node: JsonNode) {
    stats.nodes += 1;
    stats.maxDepth = Math.max(stats.maxDepth, node.depth);

    if (node.type === 'object') {
      stats.objects += 1;
    } else if (node.type === 'array') {
      stats.arrays += 1;
    } else if (node.type !== 'document') {
      stats.values += 1;
    }

    node.children.forEach(visit);
  }

  visit(root);
  return stats;
}

function collectExpandableIds(root: JsonNode) {
  const ids: string[] = [];

  function visit(node: JsonNode) {
    if (node.children.length > 0) {
      ids.push(node.id);
      node.children.forEach(visit);
    }
  }

  visit(root);
  return ids;
}

function defaultExpanded(root: JsonNode) {
  const ids = new Set<string>();

  function visit(node: JsonNode) {
    if (node.children.length > 0 && node.depth < 3) {
      ids.add(node.id);
      node.children.forEach(visit);
    }
  }

  visit(root);
  return ids;
}

function findNode(root: JsonNode, id: string): JsonNode | null {
  if (root.id === id) {
    return root;
  }

  for (const child of root.children) {
    const match = findNode(child, id);

    if (match) {
      return match;
    }
  }

  return null;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function nodeSummary(node: JsonNode) {
  if (node.type === 'object') {
    return `${node.children.length} ${node.children.length === 1 ? 'key' : 'keys'}`;
  }

  if (node.type === 'array') {
    return `${node.children.length} ${node.children.length === 1 ? 'item' : 'items'}`;
  }

  if (node.type === 'document') {
    return `${node.children.length} root values`;
  }

  if (node.type === 'string') {
    return JSON.stringify(node.value);
  }

  return String(node.value);
}

function openingToken(node: JsonNode) {
  if (node.type === 'object') {
    return '{';
  }

  if (node.type === 'array' || node.type === 'document') {
    return '[';
  }

  return '';
}

function closingToken(node: JsonNode) {
  if (node.type === 'object') {
    return '}';
  }

  if (node.type === 'array' || node.type === 'document') {
    return ']';
  }

  return '';
}

function typeTone(type: JsonType) {
  switch (type) {
    case 'object':
      return {
        badge: 'border-cyan-200 bg-cyan-50 text-cyan-800',
        rail: 'border-cyan-300',
        dot: 'bg-cyan-500',
        text: 'text-cyan-700',
      };
    case 'array':
      return {
        badge: 'border-amber-200 bg-amber-50 text-amber-800',
        rail: 'border-amber-300',
        dot: 'bg-amber-500',
        text: 'text-amber-700',
      };
    case 'string':
      return {
        badge: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        rail: 'border-emerald-300',
        dot: 'bg-emerald-500',
        text: 'text-emerald-700',
      };
    case 'number':
      return {
        badge: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800',
        rail: 'border-fuchsia-300',
        dot: 'bg-fuchsia-500',
        text: 'text-fuchsia-700',
      };
    case 'boolean':
      return {
        badge: 'border-orange-200 bg-orange-50 text-orange-800',
        rail: 'border-orange-300',
        dot: 'bg-orange-500',
        text: 'text-orange-700',
      };
    case 'null':
      return {
        badge: 'border-zinc-200 bg-zinc-50 text-zinc-700',
        rail: 'border-zinc-300',
        dot: 'bg-zinc-400',
        text: 'text-zinc-600',
      };
    default:
      return {
        badge: 'border-indigo-200 bg-indigo-50 text-indigo-800',
        rail: 'border-indigo-300',
        dot: 'bg-indigo-500',
        text: 'text-indigo-700',
      };
  }
}

function searchableText(node: JsonNode) {
  return `${node.path} ${node.label} ${node.type} ${nodeSummary(
    node,
  )}`.toLowerCase();
}

function nodeMatches(node: JsonNode, query: string) {
  return query.length === 0 || searchableText(node).includes(query);
}

function branchMatches(node: JsonNode, query: string): boolean {
  return (
    nodeMatches(node, query) ||
    node.children.some((child) => branchMatches(child, query))
  );
}

function countMatches(root: JsonNode, query: string) {
  let count = 0;

  function visit(node: JsonNode) {
    if (nodeMatches(node, query)) {
      count += 1;
    }

    node.children.forEach(visit);
  }

  visit(root);
  return count;
}

function stringifyJsonValue(value: unknown) {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function compareRoots(left: ParseOutcome, right: ParseOutcome) {
  if (!left.ok || !right.ok) {
    return null;
  }

  return {
    equal: canonicalJson(left.root.value) === canonicalJson(right.root.value),
    nodeDelta: right.stats.nodes - left.stats.nodes,
    objectDelta: right.stats.objects - left.stats.objects,
    arrayDelta: right.stats.arrays - left.stats.arrays,
    valueDelta: right.stats.values - left.stats.values,
  };
}

function countOccurrences(text: string, query: string) {
  if (!query) {
    return 0;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let count = 0;
  let from = 0;

  while (from < lowerText.length) {
    const index = lowerText.indexOf(lowerQuery, from);

    if (index === -1) {
      break;
    }

    count += 1;
    from = index + lowerQuery.length;
  }

  return count;
}

function findFormattedLines(text: string, query: string) {
  const trimmed = query.trim();

  if (!trimmed) {
    return {
      count: 0,
      lines: [] as Array<{ number: number; text: string }>,
      totalLines: text.split('\n').length,
      limited: false,
    };
  }

  const matchingLines: Array<{ number: number; text: string }> = [];
  const lines = text.split('\n');
  let count = 0;
  let matchedLineCount = 0;

  lines.forEach((line, index) => {
    const lineCount = countOccurrences(line, trimmed);

    if (lineCount > 0) {
      count += lineCount;
      matchedLineCount += 1;

      if (matchingLines.length < 80) {
        matchingLines.push({ number: index + 1, text: line });
      }
    }
  });

  return {
    count,
    lines: matchingLines,
    totalLines: matchedLineCount,
    limited: matchedLineCount > matchingLines.length,
  };
}

function HighlightedText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const trimmed = query.trim();

  if (!trimmed) {
    return <>{text}</>;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;

  while (from < text.length) {
    const index = lowerText.indexOf(lowerQuery, from);

    if (index === -1) {
      parts.push(text.slice(from));
      break;
    }

    if (index > from) {
      parts.push(text.slice(from, index));
    }

    parts.push(
      <mark
        className="rounded bg-amber-200 px-0.5 text-amber-950"
        key={`${index}-${from}`}
      >
        {text.slice(index, index + trimmed.length)}
      </mark>,
    );
    from = index + trimmed.length;
  }

  return <>{parts}</>;
}

const initialParse = parseJsonInput(SAMPLE_JSON);
const initialCompareParse = parseJsonInput(COMPARE_SAMPLE_JSON);

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rightFileInputRef = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState(SAMPLE_JSON);
  const [fileName, setFileName] = useState('demo.json');
  const [parseOutcome, setParseOutcome] = useState<ParseOutcome>(initialParse);
  const [rightSource, setRightSource] = useState(COMPARE_SAMPLE_JSON);
  const [rightFileName, setRightFileName] = useState('compare.json');
  const [rightParseOutcome, setRightParseOutcome] =
    useState<ParseOutcome>(initialCompareParse);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    initialParse.ok ? defaultExpanded(initialParse.root) : new Set(),
  );
  const [rightExpanded, setRightExpanded] = useState<Set<string>>(() =>
    initialCompareParse.ok
      ? defaultExpanded(initialCompareParse.root)
      : new Set(),
  );
  const [selectedId, setSelectedId] = useState(() =>
    initialParse.ok ? initialParse.root.id : '',
  );
  const [selectedSide, setSelectedSide] = useState<PaneId>('left');
  const [query, setQuery] = useState('');
  const [formattedQuery, setFormattedQuery] = useState('');
  const [copyState, setCopyState] = useState('');
  const [compareMode, setCompareMode] = useState(false);
  const [sourceCompact, setSourceCompact] = useState(false);
  const [rightSourceCompact, setRightSourceCompact] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  const selectedNode = useMemo(() => {
    const outcome = selectedSide === 'right' ? rightParseOutcome : parseOutcome;

    if (!outcome.ok) {
      return null;
    }

    return findNode(outcome.root, selectedId) ?? outcome.root;
  }, [parseOutcome, rightParseOutcome, selectedId, selectedSide]);
  const selectedSource = selectedSide === 'right' ? rightSource : source;
  const matchCount = useMemo(() => {
    if (!normalizedQuery) {
      return null;
    }

    let total = parseOutcome.ok
      ? countMatches(parseOutcome.root, normalizedQuery)
      : 0;

    if (compareMode && rightParseOutcome.ok) {
      total += countMatches(rightParseOutcome.root, normalizedQuery);
    }

    return total;
  }, [compareMode, parseOutcome, rightParseOutcome, normalizedQuery]);
  const comparison = useMemo(
    () => compareRoots(parseOutcome, rightParseOutcome),
    [parseOutcome, rightParseOutcome],
  );
  const anyParsed = parseOutcome.ok || (compareMode && rightParseOutcome.ok);
  const allVisibleParsed =
    parseOutcome.ok && (!compareMode || rightParseOutcome.ok);

  const applyParsedPane = (
    pane: PaneId,
    nextSource: string,
    nextFileName: string,
  ) => {
    const outcome = parseJsonInput(nextSource);

    if (pane === 'right') {
      setRightSource(nextSource);
      setRightFileName(nextFileName);
      setRightParseOutcome(outcome);
      setRightExpanded(outcome.ok ? defaultExpanded(outcome.root) : new Set());
    } else {
      setSource(nextSource);
      setFileName(nextFileName);
      setParseOutcome(outcome);
      setExpanded(outcome.ok ? defaultExpanded(outcome.root) : new Set());
    }

    setSelectedSide(pane);
    setQuery('');
    setCopyState('');
    setFormattedQuery('');

    if (outcome.ok) {
      setSelectedId(outcome.root.id);
    } else {
      setSelectedId('');
    }

    return outcome;
  };

  function runParse(nextSource = source, nextFileName = fileName) {
    applyParsedPane('left', nextSource, nextFileName);
  }

  function runRightParse(
    nextSource = rightSource,
    nextFileName = rightFileName,
  ) {
    applyParsedPane('right', nextSource, nextFileName);
  }

  async function readFile(file: File, pane: PaneId = 'left') {
    const extensionOk = /\.(json|txt)$/i.test(file.name);
    const mimeOk =
      file.type === 'application/json' ||
      file.type === 'text/plain' ||
      file.type === '';

    if (!extensionOk && !mimeOk) {
      const failure: ParseFailure = {
        ok: false,
        message: 'Upload a .json or .txt file.',
        line: 1,
        column: 1,
        excerpt: file.name,
        pointer: '^',
      };

      if (pane === 'right') {
        setRightParseOutcome(failure);
        setRightExpanded(new Set());
      } else {
        setParseOutcome(failure);
        setExpanded(new Set());
      }

      setSelectedSide(pane);
      setSelectedId('');
      return;
    }

    const text = await file.text();
    applyParsedPane(pane, text, file.name);
  }

  function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
    pane: PaneId = 'left',
  ) {
    const file = event.target.files?.[0];

    if (file) {
      void readFile(file, pane);
    }

    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);

    const file = event.dataTransfer.files[0];

    if (file) {
      void readFile(file, 'left');
    }
  }

  function toggleNode(id: string, pane: PaneId = 'left') {
    const setPaneExpanded = pane === 'right' ? setRightExpanded : setExpanded;

    setPaneExpanded((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function expandAll() {
    if (parseOutcome.ok) {
      setExpanded(new Set(collectExpandableIds(parseOutcome.root)));
    }

    if (compareMode && rightParseOutcome.ok) {
      setRightExpanded(new Set(collectExpandableIds(rightParseOutcome.root)));
    }
  }

  function collapseAll() {
    if (parseOutcome.ok) {
      setExpanded(new Set([parseOutcome.root.id]));
    }

    if (compareMode && rightParseOutcome.ok) {
      setRightExpanded(new Set([rightParseOutcome.root.id]));
    }
  }

  async function copyPath() {
    if (!selectedNode) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedNode.path);
      setCopyState('Path copied');
      window.setTimeout(() => setCopyState(''), 1400);
    } catch {
      setCopyState('Copy failed');
      window.setTimeout(() => setCopyState(''), 1400);
    }
  }

  function loadSample() {
    setSource(SAMPLE_JSON);
    runParse(SAMPLE_JSON, 'demo.json');
  }

  function loadCompareSample() {
    setRightSource(COMPARE_SAMPLE_JSON);
    runRightParse(COMPARE_SAMPLE_JSON, 'compare.json');
  }

  function clearInput() {
    setSource('');
    setFileName('untitled');
    setParseOutcome(parseJsonInput(''));
    setExpanded(new Set());
    setSelectedSide('left');
    setSelectedId('');
    setQuery('');
    setFormattedQuery('');
  }

  function clearCompareInput() {
    setRightSource('');
    setRightFileName('compare.json');
    setRightParseOutcome(parseJsonInput(''));
    setRightExpanded(new Set());
    setSelectedSide('right');
    setSelectedId('');
    setQuery('');
    setFormattedQuery('');
  }

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-background text-foreground">
        <header className="border-b border-border bg-card">
          <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-primary/20 bg-primary/10">
                <Image
                  src={publicAsset('/desirializer-icon.png')}
                  alt=""
                  width={40}
                  height={40}
                  className="size-full object-cover"
                  priority
                />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold">Desirializer</h1>
                <p className="text-sm text-muted-foreground">
                  Map any JSON into clear starts, contents, endings, and next
                  entries.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {allVisibleParsed ? (
                <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">
                  <CheckCircle2 data-icon="inline-start" className="size-3" />
                  Parsed
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <AlertTriangle data-icon="inline-start" className="size-3" />
                  Needs valid JSON
                </Badge>
              )}
              <Badge variant="outline">v{APP_VERSION}</Badge>
              <Badge variant="outline" className="max-w-[220px] truncate">
                {compareMode ? `A ${fileName}` : fileName}
              </Badge>
              {compareMode && (
                <Badge variant="outline" className="max-w-[220px] truncate">
                  B {rightFileName}
                </Badge>
              )}
              {parseOutcome.ok && (
                <Badge variant="outline">
                  {parseOutcome.mode === 'stream'
                    ? `${parseOutcome.stats.roots} roots`
                    : 'single root'}
                </Badge>
              )}
              <Button
                type="button"
                variant={compareMode ? 'default' : 'outline'}
                onClick={() => {
                  setCompareMode((current) => !current);
                  setFormattedQuery('');
                }}
              >
                <ListTree data-icon="inline-start" className="size-4" />
                Compare
              </Button>
            </div>
          </div>
        </header>

        <div className="grid min-h-[calc(100vh-89px)] grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)_360px]">
          <section className="border-b border-border bg-card/70 lg:border-b-0 lg:border-r">
            <div className="flex h-full flex-col gap-4 p-4 sm:p-5">
              <div
                className={`flex min-h-28 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-4 text-center transition-colors ${
                  dragActive
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-background'
                }`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
              >
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  accept=".json,.txt,application/json,text/plain"
                  onChange={handleFileChange}
                />
                <input
                  ref={rightFileInputRef}
                  className="sr-only"
                  type="file"
                  accept=".json,.txt,application/json,text/plain"
                  onChange={(event) => handleFileChange(event, 'right')}
                />
                <div className="flex size-10 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <Upload className="size-5" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">
                    Drop a JSON or text file
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Or paste JSON text below.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileJson data-icon="inline-start" className="size-4" />
                  Choose file
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={() => runParse()}>
                  <ListTree data-icon="inline-start" className="size-4" />
                  {compareMode ? 'Parse A' : 'Parse'}
                </Button>
                <Button type="button" variant="outline" onClick={loadSample}>
                  <FileText data-icon="inline-start" className="size-4" />
                  Sample A
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Clear input"
                        onClick={clearInput}
                      >
                        <X className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipContent>Clear input</TooltipContent>
                </Tooltip>
              </div>

              <div
                className={`flex flex-col gap-2 ${
                  sourceCompact ? 'min-h-0' : 'min-h-[300px] flex-1'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <label
                      className="block text-sm font-medium"
                      htmlFor="json-source"
                    >
                      {compareMode ? 'JSON A source' : 'JSON source'}
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Paste raw JSON here when you do not have a file.
                    </p>
                  </div>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={
                            sourceCompact
                              ? 'Expand JSON source input'
                              : 'Compact JSON source input'
                          }
                          onClick={() =>
                            setSourceCompact((current) => !current)
                          }
                        >
                          {sourceCompact ? (
                            <Maximize2 className="size-4" />
                          ) : (
                            <Minimize2 className="size-4" />
                          )}
                        </Button>
                      }
                    />
                    <TooltipContent>
                      {sourceCompact ? 'Expand source' : 'Compact source'}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Textarea
                  id="json-source"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className={`[field-sizing:fixed] resize-y overflow-auto border-border bg-background font-mono text-sm leading-6 ${
                    sourceCompact
                      ? 'h-24 min-h-24 max-h-24'
                      : 'h-[320px] min-h-[220px] flex-1'
                  }`}
                  placeholder='Paste {"json": true} here'
                />
              </div>

              {compareMode && (
                <div className="rounded-lg border border-border bg-background p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <label
                        className="block text-sm font-medium"
                        htmlFor="json-source-b"
                      >
                        JSON B source
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Paste text or choose a second file.
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => rightFileInputRef.current?.click()}
                      >
                        <FileJson
                          data-icon="inline-start"
                          className="size-4"
                        />
                        Choose B
                      </Button>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={
                                rightSourceCompact
                                  ? 'Expand JSON B source input'
                                  : 'Compact JSON B source input'
                              }
                              onClick={() =>
                                setRightSourceCompact((current) => !current)
                              }
                            >
                              {rightSourceCompact ? (
                                <Maximize2 className="size-4" />
                              ) : (
                                <Minimize2 className="size-4" />
                              )}
                            </Button>
                          }
                        />
                        <TooltipContent>
                          {rightSourceCompact
                            ? 'Expand source B'
                            : 'Compact source B'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <Textarea
                    id="json-source-b"
                    value={rightSource}
                    onChange={(event) => setRightSource(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className={`mt-3 [field-sizing:fixed] resize-y overflow-auto border-border bg-card font-mono text-sm leading-6 ${
                      rightSourceCompact
                        ? 'h-24 min-h-24 max-h-24'
                        : 'h-[220px] min-h-[160px]'
                    }`}
                    placeholder='Paste {"compare": true} here'
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => runRightParse()}
                    >
                      <ListTree data-icon="inline-start" className="size-4" />
                      Parse B
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={loadCompareSample}
                    >
                      <FileText data-icon="inline-start" className="size-4" />
                      Sample B
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearCompareInput}
                    >
                      Clear B
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="flex min-h-[560px] flex-col bg-background lg:min-h-0">
            <div className="border-b border-border p-4 sm:p-5">
              {compareMode ? (
                <div className="grid gap-3 xl:grid-cols-2">
                  <DatasetSummary
                    label="JSON A"
                    fileName={fileName}
                    outcome={parseOutcome}
                  />
                  <DatasetSummary
                    label="JSON B"
                    fileName={rightFileName}
                    outcome={rightParseOutcome}
                  />
                  {comparison && (
                    <ComparisonSummary comparison={comparison} />
                  )}
                </div>
              ) : parseOutcome.ok ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatCell
                    icon={<Database className="size-4" />}
                    label="Nodes"
                    value={String(parseOutcome.stats.nodes)}
                  />
                  <StatCell
                    icon={<Braces className="size-4" />}
                    label="Objects"
                    value={String(parseOutcome.stats.objects)}
                  />
                  <StatCell
                    icon={<ListTree className="size-4" />}
                    label="Arrays"
                    value={String(parseOutcome.stats.arrays)}
                  />
                  <StatCell
                    icon={<FileText className="size-4" />}
                    label="Source"
                    value={formatBytes(parseOutcome.stats.bytes)}
                  />
                </div>
              ) : (
                <ErrorPanel error={parseOutcome} />
              )}

              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    autoComplete="off"
                    placeholder={
                      compareMode
                        ? 'Search both trees by path, key, type, or value'
                        : 'Search path, key, type, or value'
                    }
                    className="pl-8"
                    disabled={!anyParsed}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="Expand all"
                          onClick={expandAll}
                          disabled={!anyParsed}
                        >
                          <Maximize2 className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipContent>Expand all</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="Collapse all"
                          onClick={collapseAll}
                          disabled={!anyParsed}
                        >
                          <Minimize2 className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipContent>Collapse all</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              {anyParsed && normalizedQuery && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {matchCount} {matchCount === 1 ? 'match' : 'matches'} visible
                  with ancestors.
                </p>
              )}
            </div>

            <ScrollArea className="flex-1">
              <div
                className={`p-4 sm:p-5 ${
                  compareMode ? 'min-w-[980px]' : 'min-w-[720px]'
                }`}
              >
                {compareMode ? (
                  <div className="grid gap-4 xl:grid-cols-2">
                    <TreePane
                      label="JSON A"
                      outcome={parseOutcome}
                      expanded={expanded}
                      selectedId={selectedSide === 'left' ? selectedId : ''}
                      query={normalizedQuery}
                      onToggle={(id) => toggleNode(id, 'left')}
                      onSelect={(id) => {
                        setSelectedSide('left');
                        setSelectedId(id);
                        setCopyState('');
                        setFormattedQuery('');
                      }}
                    />
                    <TreePane
                      label="JSON B"
                      outcome={rightParseOutcome}
                      expanded={rightExpanded}
                      selectedId={selectedSide === 'right' ? selectedId : ''}
                      query={normalizedQuery}
                      onToggle={(id) => toggleNode(id, 'right')}
                      onSelect={(id) => {
                        setSelectedSide('right');
                        setSelectedId(id);
                        setCopyState('');
                        setFormattedQuery('');
                      }}
                    />
                  </div>
                ) : parseOutcome.ok ? (
                  <TreePane
                    outcome={parseOutcome}
                    expanded={expanded}
                    selectedId={selectedId}
                    query={normalizedQuery}
                    onToggle={(id) => toggleNode(id, 'left')}
                    onSelect={(id) => {
                      setSelectedSide('left');
                      setSelectedId(id);
                      setCopyState('');
                      setFormattedQuery('');
                    }}
                  />
                ) : (
                  <div className="flex min-h-80 items-center justify-center rounded-lg border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
                    Fix the source on the left, then parse again.
                  </div>
                )}
              </div>
            </ScrollArea>
          </section>

          <aside className="border-t border-border bg-card/70 lg:border-l lg:border-t-0">
            <Inspector
              node={selectedNode}
              source={selectedSource}
              paneLabel={selectedSide === 'right' ? 'JSON B' : 'JSON A'}
              formattedQuery={formattedQuery}
              onFormattedQueryChange={setFormattedQuery}
              copyState={copyState}
              onCopyPath={() => void copyPath()}
            />
          </aside>
        </div>
      </main>
    </TooltipProvider>
  );
}

function StatCell({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function ErrorPanel({ error }: { error: ParseFailure }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">{error.message}</p>
          <p className="text-sm">
            Line {error.line}, column {error.column}
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-background/80 p-3 font-mono text-xs text-foreground">
            <code>{`${error.excerpt}\n${error.pointer}`}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

function DatasetSummary({
  label,
  fileName,
  outcome,
}: {
  label: string;
  fileName: string;
  outcome: ParseOutcome;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{label}</p>
          <p className="truncate text-xs text-muted-foreground">{fileName}</p>
        </div>
        {outcome.ok ? (
          <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">
            parsed
          </Badge>
        ) : (
          <Badge variant="destructive">error</Badge>
        )}
      </div>

      {outcome.ok ? (
        <div className="grid grid-cols-4 gap-2 text-sm">
          <MiniStat label="Nodes" value={String(outcome.stats.nodes)} />
          <MiniStat label="Objects" value={String(outcome.stats.objects)} />
          <MiniStat label="Arrays" value={String(outcome.stats.arrays)} />
          <MiniStat label="Size" value={formatBytes(outcome.stats.bytes)} />
        </div>
      ) : (
        <p className="text-sm text-destructive">
          Line {outcome.line}, column {outcome.column}
        </p>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-semibold">{value}</p>
    </div>
  );
}

function ComparisonSummary({
  comparison,
}: {
  comparison: NonNullable<ReturnType<typeof compareRoots>>;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3 xl:col-span-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className={
            comparison.equal
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }
        >
          {comparison.equal ? 'same data' : 'different data'}
        </Badge>
        <span className="text-sm text-muted-foreground">
          B vs A: {formatSigned(comparison.nodeDelta)} nodes,{' '}
          {formatSigned(comparison.objectDelta)} objects,{' '}
          {formatSigned(comparison.arrayDelta)} arrays,{' '}
          {formatSigned(comparison.valueDelta)} values.
        </span>
      </div>
    </div>
  );
}

function formatSigned(value: number) {
  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}

function TreePane({
  label,
  outcome,
  expanded,
  selectedId,
  query,
  onToggle,
  onSelect,
}: {
  label?: string;
  outcome: ParseOutcome;
  expanded: Set<string>;
  selectedId: string;
  query: string;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="min-w-0">
      {label && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{label}</h2>
          {outcome.ok && (
            <Badge variant="outline">
              {outcome.mode === 'stream'
                ? `${outcome.stats.roots} roots`
                : 'single root'}
            </Badge>
          )}
        </div>
      )}

      {outcome.ok ? (
        <JsonTreeNode
          node={outcome.root}
          expanded={expanded}
          selectedId={selectedId}
          query={query}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ) : (
        <div className="flex min-h-80 items-center justify-center rounded-lg border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          Fix this source, then parse again.
        </div>
      )}
    </div>
  );
}

function JsonTreeNode({
  node,
  expanded,
  selectedId,
  query,
  onToggle,
  onSelect,
}: {
  node: JsonNode;
  expanded: Set<string>;
  selectedId: string;
  query: string;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  if (query && !branchMatches(node, query)) {
    return null;
  }

  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  const tone = typeTone(node.type);
  const isSelected = selectedId === node.id;
  const isMatch = query.length > 0 && nodeMatches(node, query);
  const spanLabel = `${lineLabel(node.start)} to ${lineLabel(node.end)}`;

  return (
    <div className="py-1">
      <div
        className={`group flex min-w-0 items-start gap-2 overflow-hidden rounded-lg border px-2 py-2 transition-colors ${
          isSelected
            ? 'border-primary bg-primary/10'
            : isMatch
              ? 'border-amber-300 bg-amber-50/70'
              : 'border-transparent hover:border-border hover:bg-card'
        }`}
      >
        {hasChildren ? (
          <button
            type="button"
            className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={isExpanded ? 'Collapse node' : 'Expand node'}
            onClick={() => onToggle(node.id)}
          >
            {isExpanded ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className={`mt-2 size-2 shrink-0 rounded-full ${tone.dot}`} />
        )}

        <button
          type="button"
          aria-label={`Select ${node.path}`}
          className="grid min-w-0 flex-1 grid-cols-1 items-start gap-2 text-left md:grid-cols-[minmax(120px,0.75fr)_minmax(160px,1.25fr)]"
          onClick={() => onSelect(node.id)}
        >
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm font-semibold">
              {node.label}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {node.path}
            </span>
          </span>

          <span className="min-w-0">
            <span
              className={`block max-h-28 max-w-full overflow-auto whitespace-pre-wrap break-all pr-1 font-mono text-sm ${tone.text}`}
            >
              {hasChildren
                ? `${openingToken(node)} ${nodeSummary(node)}`
                : nodeSummary(node)}
            </span>
            <span className="block break-words text-xs text-muted-foreground">
              {hasChildren
                ? `starts ${lineLabel(node.start)}, ends ${lineLabel(node.end)}`
                : `value at ${spanLabel}`}
            </span>
          </span>

          <span className="flex min-w-0 flex-wrap justify-start gap-2 md:col-span-2">
            <Badge variant="outline" className={tone.badge}>
              {node.type}
            </Badge>
            <Badge variant="outline">L {node.start.line}</Badge>
          </span>
        </button>
      </div>

      {hasChildren && isExpanded && (
        <div className={`ml-3 border-l-2 pl-4 ${tone.rail}`}>
          <div className="flex items-center gap-2 py-2 font-mono text-xs text-muted-foreground">
            <span className={tone.text}>{openingToken(node)}</span>
            <span>start {lineLabel(node.start)}</span>
          </div>

          <div className="space-y-1">
            {node.children.map((child, index) => (
              <div key={child.id}>
                <JsonTreeNode
                  node={child}
                  expanded={expanded}
                  selectedId={selectedId}
                  query={query}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
                {index < node.children.length - 1 && (
                  <div className="ml-8 flex items-center gap-2 py-1 text-xs text-muted-foreground">
                    <span className="h-px w-8 bg-border" />
                    <span>
                      next starts {lineLabel(node.children[index + 1].start)}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 py-2 font-mono text-xs text-muted-foreground">
            <span className={tone.text}>{closingToken(node)}</span>
            <span>end {lineLabel(node.end)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Inspector({
  node,
  source,
  paneLabel,
  formattedQuery,
  onFormattedQueryChange,
  copyState,
  onCopyPath,
}: {
  node: JsonNode | null;
  source: string;
  paneLabel: string;
  formattedQuery: string;
  onFormattedQueryChange: (query: string) => void;
  copyState: string;
  onCopyPath: () => void;
}) {
  if (!node) {
    return (
      <div className="p-5">
        <h2 className="text-base font-semibold">Inspector</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Select a parsed node to inspect its path, source span, and raw slice.
        </p>
      </div>
    );
  }

  const rawSlice = source.slice(node.startIndex, node.endIndex);
  const reserialized = stringifyJsonValue(node.value);
  const formattedSearch = findFormattedLines(reserialized, formattedQuery);
  const tone = typeTone(node.type);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">Inspector</h2>
            <p className="mt-1 truncate font-mono text-sm text-muted-foreground">
              {paneLabel} {node.path}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Copy path"
            onClick={onCopyPath}
          >
            <Copy className="size-4" />
          </Button>
        </div>
        {copyState && (
          <p className="mt-2 text-sm text-muted-foreground">{copyState}</p>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2">
            <InfoTile label="Type" value={node.type} tone={tone.badge} />
            <InfoTile label="Depth" value={String(node.depth)} />
            <InfoTile label="Starts" value={lineLabel(node.start)} />
            <InfoTile label="Ends" value={lineLabel(node.end)} />
            <InfoTile
              label="Contains"
              value={
                node.children.length > 0
                  ? String(node.children.length)
                  : 'value'
              }
            />
            <InfoTile
              label="Characters"
              value={String(node.endIndex - node.startIndex)}
            />
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Value summary</p>
            <div className="rounded-lg border border-border bg-background p-3 font-mono text-sm">
              {nodeSummary(node)}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Raw source slice</p>
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 text-foreground">
              <code>{rawSlice}</code>
            </pre>
          </div>

          <div>
            <div className="mb-2 flex flex-col gap-2">
              <p className="text-sm font-medium">Reserialized JSON</p>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={formattedQuery}
                  onChange={(event) =>
                    onFormattedQueryChange(event.target.value)
                  }
                  autoComplete="off"
                  placeholder="Find inside the formatted JSON"
                  className="pl-8"
                  aria-label="Find inside reserialized JSON"
                />
              </div>
              {formattedQuery.trim() && (
                <p className="text-xs text-muted-foreground">
                  {formattedSearch.count}{' '}
                  {formattedSearch.count === 1 ? 'match' : 'matches'} across{' '}
                  {formattedSearch.totalLines}{' '}
                  {formattedSearch.totalLines === 1 ? 'line' : 'lines'}.
                </p>
              )}
            </div>

            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 text-foreground">
              <code>
                {formattedQuery.trim() ? (
                  formattedSearch.lines.length > 0 ? (
                    <>
                      {formattedSearch.lines.map((line) => (
                        <span className="block" key={line.number}>
                          <span className="select-none text-muted-foreground">
                            {String(line.number).padStart(4, ' ')} |
                          </span>{' '}
                          <HighlightedText
                            text={line.text}
                            query={formattedQuery}
                          />
                        </span>
                      ))}
                      {formattedSearch.limited && (
                        <span className="block pt-2 text-muted-foreground">
                          Showing first 80 matching lines.
                        </span>
                      )}
                    </>
                  ) : (
                    'No matches in the reserialized JSON.'
                  )
                ) : (
                  reserialized
                )}
              </code>
            </pre>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function InfoTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 truncate text-sm font-semibold ${
          tone ?? 'text-foreground'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
