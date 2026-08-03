/**
 * A minimal DOM used to exercise the browser-only UI modules under `bun test`.
 *
 * Fixtures come from the checked-in page sources (`src/ui/**\/index.html`) so
 * these tests fail when a selector drifts away from the markup that ships.
 * Timers, animation frames, and `performance.now` run on a virtual clock that
 * only advances when a test asks it to, which keeps debounced and delayed paths
 * fast and deterministic.
 */

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity) => {
    const token = String(entity);
    if (token.startsWith("#x") || token.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(token.substring(2), 16));
    }
    if (token.startsWith("#")) {
      return String.fromCodePoint(Number(token.substring(1)));
    }
    return ENTITIES[token.toLowerCase()] ?? match;
  });
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

interface SimpleSelector {
  attributes: { name: string; value?: string }[];
  classes: string[];
  id?: string;
  negations: SimpleSelector[];
  tag?: string;
}

const SELECTOR_TOKEN =
  /^(?:(?<tag>[a-z][\w-]*)|#(?<id>[\w-]+)|\.(?<cls>[\w-]+)|\[(?<attr>[\w-]+)(?:=(?<quote>["'])(?<value>[^"']*)\k<quote>)?\]|:not\((?<not>[^()]+)\))/i;

function parseSimpleSelector(source: string): SimpleSelector {
  const selector: SimpleSelector = {
    attributes: [],
    classes: [],
    negations: [],
  };
  let rest = source.trim();
  if (!rest) {
    throw new Error("Empty selector");
  }
  while (rest) {
    const match = rest.match(SELECTOR_TOKEN);
    if (!match?.groups) {
      throw new Error(
        `Unsupported selector syntax: ${source} (the test DOM only implements compound selectors)`
      );
    }
    const { tag, id, cls, attr, value, not } = match.groups;
    if (tag) {
      selector.tag = tag.toLowerCase();
    } else if (id) {
      selector.id = id;
    } else if (cls) {
      selector.classes.push(cls);
    } else if (attr) {
      selector.attributes.push(
        value === undefined ? { name: attr } : { name: attr, value }
      );
    } else if (not) {
      selector.negations.push(parseSimpleSelector(not));
    }
    rest = rest.substring(match[0].length);
  }
  return selector;
}

type Combinator = "child" | "descendant";

interface SelectorStep {
  /** How this step connects to the step on its left. */
  combinator: Combinator;
  simple: SimpleSelector;
}

/** Splits a compound selector chain, respecting `[...]` and `(...)` nesting. */
function splitSteps(
  source: string
): { combinator: Combinator; text: string }[] {
  const steps: { combinator: Combinator; text: string }[] = [];
  let depth = 0;
  let current = "";
  let combinator: Combinator = "descendant";
  const push = (next: Combinator): void => {
    if (current.trim()) {
      steps.push({ combinator, text: current.trim() });
      combinator = next;
    } else if (steps.length > 0) {
      combinator = next;
    }
    current = "";
  };
  for (const char of source.trim()) {
    if (char === "[" || char === "(") {
      depth++;
    } else if (char === "]" || char === ")") {
      depth--;
    }
    if (depth === 0 && (char === " " || char === "\t" || char === "\n")) {
      push("descendant");
      continue;
    }
    if (depth === 0 && char === ">") {
      push("child");
      continue;
    }
    current += char;
  }
  push("descendant");
  return steps;
}

function parseComplexSelector(source: string): SelectorStep[] {
  return splitSteps(source).map(({ combinator, text }) => ({
    combinator,
    simple: parseSimpleSelector(text),
  }));
}

function parseSelectorList(source: string): SelectorStep[][] {
  return source.split(",").map((part) => parseComplexSelector(part));
}

/** Matches a selector chain right-to-left, walking up from `element`. */
function matchesComplex(element: FakeElement, steps: SelectorStep[]): boolean {
  let index = steps.length - 1;
  if (!matchesSimple(element, steps[index].simple)) {
    return false;
  }
  let ancestor = element.parentElement;
  while (index > 0) {
    const { combinator } = steps[index];
    const target = steps[index - 1].simple;
    if (combinator === "child") {
      if (!(ancestor && matchesSimple(ancestor, target))) {
        return false;
      }
      ancestor = ancestor.parentElement;
    } else {
      while (ancestor && !matchesSimple(ancestor, target)) {
        ancestor = ancestor.parentElement;
      }
      if (!ancestor) {
        return false;
      }
      ancestor = ancestor.parentElement;
    }
    index--;
  }
  return true;
}

function matchesAny(
  element: FakeElement,
  selectors: SelectorStep[][]
): boolean {
  return selectors.some((steps) => matchesComplex(element, steps));
}

function matchesSimple(
  element: FakeElement,
  selector: SimpleSelector
): boolean {
  if (selector.tag && element.tagName.toLowerCase() !== selector.tag) {
    return false;
  }
  if (selector.id !== undefined && element.id !== selector.id) {
    return false;
  }
  for (const cls of selector.classes) {
    if (!element.classList.contains(cls)) {
      return false;
    }
  }
  for (const { name, value } of selector.attributes) {
    const actual = element.getAttribute(name);
    if (actual === null || (value !== undefined && actual !== value)) {
      return false;
    }
  }
  return selector.negations.every(
    (negation) => !matchesSimple(element, negation)
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export class DomEvent {
  bubbles: boolean;
  cancelable: boolean;
  currentTarget: FakeNode | null = null;
  defaultPrevented = false;
  detail: unknown;
  propagationStopped = false;
  returnValue: unknown = true;
  target: FakeNode | null = null;
  readonly type: string;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.detail = init.detail;
    Object.assign(this, init);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }
}

export class DomKeyboardEvent extends DomEvent {
  altKey = false;
  ctrlKey = false;
  key = "";
  metaKey = false;
  repeat = false;
  shiftKey = false;

  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, init);
    // Field initializers above run after `super()`, so `init` is applied again.
    Object.assign(this, init);
  }
}

interface ListenerRecord {
  listener: (event: DomEvent) => unknown;
  once: boolean;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  private readonly listeners = new Map<string, ListenerRecord[]>();

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== "") {
      this.appendChild(new FakeText(value));
    }
  }

  addEventListener(
    type: string,
    listener: (event: DomEvent) => unknown,
    options?: { once?: boolean }
  ): void {
    const records = this.listeners.get(type) ?? [];
    records.push({ listener, once: Boolean(options?.once) });
    this.listeners.set(type, records);
  }

  removeEventListener(
    type: string,
    listener: (event: DomEvent) => unknown
  ): void {
    const records = this.listeners.get(type);
    if (!records) {
      return;
    }
    const index = records.findIndex((record) => record.listener === listener);
    if (index !== -1) {
      records.splice(index, 1);
    }
  }

  /** Runs listeners on this node then, for bubbling events, each ancestor. */
  dispatchEvent(event: DomEvent): boolean {
    if (!event.target) {
      event.target = this;
    }
    let node: FakeNode | null = this;
    while (node) {
      node.runListeners(event);
      if (!event.bubbles || event.propagationStopped) {
        break;
      }
      node = node.parentNode ?? node.ownerDefaultTarget();
    }
    return !event.defaultPrevented;
  }

  /** Lets an event dispatched on a detached tree still reach `document`. */
  protected ownerDefaultTarget(): FakeNode | null {
    return null;
  }

  private runListeners(event: DomEvent): void {
    const records = this.listeners.get(event.type);
    if (!records?.length) {
      return;
    }
    event.currentTarget = this;
    for (const record of [...records]) {
      if (record.once) {
        this.removeEventListener(event.type, record.listener);
      }
      record.listener.call(this, event);
    }
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  contains(other: FakeNode | null): boolean {
    let node = other;
    while (node) {
      if (node === this) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }
}

export class FakeText extends FakeNode {
  data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(value: string) {
    this.data = value;
  }
}

class ClassList {
  private readonly classes = new Set<string>();

  add(...classes: string[]): void {
    for (const cls of classes) {
      this.classes.add(cls);
    }
  }

  contains(cls: string): boolean {
    return this.classes.has(cls);
  }

  remove(...classes: string[]): void {
    for (const cls of classes) {
      this.classes.delete(cls);
    }
  }

  replace(oldClass: string, newClass: string): boolean {
    if (!this.classes.delete(oldClass)) {
      return false;
    }
    this.classes.add(newClass);
    return true;
  }

  toggle(cls: string, force?: boolean): boolean {
    const next = force ?? !this.classes.has(cls);
    if (next) {
      this.classes.add(cls);
    } else {
      this.classes.delete(cls);
    }
    return next;
  }

  get value(): string {
    return [...this.classes].join(" ");
  }

  set value(next: string) {
    this.classes.clear();
    for (const cls of next.split(/\s+/).filter(Boolean)) {
      this.classes.add(cls);
    }
  }

  toString(): string {
    return this.value;
  }
}

/** Mirrors `CSSStyleDeclaration` closely enough for the properties in use. */
class Style {
  [property: string]: unknown;

  removeProperty(property: string): void {
    const camel = property.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase()
    );
    delete this[camel];
    delete this[property];
  }
}

export class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly classList = new ClassList();
  readonly tagName: string;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter(
      (child): child is FakeElement => child instanceof FakeElement
    );
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  set id(value: string) {
    this.setAttribute("id", value);
  }

  get className(): string {
    return this.classList.value;
  }

  set className(value: string) {
    this.classList.value = value;
  }

  getAttribute(name: string): string | null {
    if (name === "class") {
      return this.classList.value;
    }
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    if (name === "class") {
      this.classList.value = value;
      return;
    }
    this.attributes.set(name.toLowerCase(), String(value));
  }

  removeAttribute(name: string): void {
    if (name === "class") {
      this.classList.value = "";
      return;
    }
    this.attributes.delete(name.toLowerCase());
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      this.appendChild(typeof node === "string" ? new FakeText(node) : node);
    }
  }

  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const child of [...this.childNodes]) {
      this.removeChild(child);
    }
    this.append(...nodes);
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  matches(selector: string): boolean {
    return matchesAny(this, parseSelectorList(selector));
  }

  closest(selector: string): FakeElement | null {
    const selectors = parseSelectorList(selector);
    let node: FakeElement | null = this;
    while (node) {
      if (matchesAny(node, selectors)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const selectors = parseSelectorList(selector);
    const found: FakeElement[] = [];
    const visit = (node: FakeNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) {
          if (matchesAny(child, selectors)) {
            found.push(child);
          }
          visit(child);
        }
      }
    };
    visit(this);
    return found;
  }
}

export class FakeHTMLElement extends FakeElement {
  readonly dataset: Record<string, string | undefined> = {};
  offsetWidth = 0;
  offsetHeight = 0;
  readonly style = new Style();

  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }

  set hidden(value: boolean) {
    if (value) {
      this.setAttribute("hidden", "");
    } else {
      this.removeAttribute("hidden");
    }
  }

  get title(): string {
    return this.getAttribute("title") ?? "";
  }

  set title(value: string) {
    this.setAttribute("title", value);
  }

  get role(): string {
    return this.getAttribute("role") ?? "";
  }

  set role(value: string) {
    this.setAttribute("role", value);
  }

  get tabIndex(): number {
    return Number(this.getAttribute("tabindex") ?? "-1");
  }

  set tabIndex(value: number) {
    this.setAttribute("tabindex", String(value));
  }

  blur(): void {
    if (activeDocument?.activeElement === this) {
      activeDocument.activeElement = activeDocument.body;
    }
  }

  click(): void {
    this.dispatchEvent(new DomEvent("click", { bubbles: true }));
  }

  focus(): void {
    if (activeDocument) {
      activeDocument.activeElement = this;
    }
  }

  getBoundingClientRect(): {
    bottom: number;
    height: number;
    left: number;
    right: number;
    top: number;
    width: number;
  } {
    return {
      bottom: this.offsetHeight,
      height: this.offsetHeight,
      left: 0,
      right: this.offsetWidth,
      top: 0,
      width: this.offsetWidth,
    };
  }

  scrollIntoView(): void {
    /* Layout is not modelled; call sites only need this to exist. */
  }

  protected override ownerDefaultTarget(): FakeNode | null {
    const owner = activeDocument as unknown as FakeNode | null;
    return owner && (this as unknown as FakeNode) !== owner ? owner : null;
  }
}

/** Shared value/disabled/name behaviour for form controls. */
class FormControlElement extends FakeHTMLElement {
  disabled = false;

  get name(): string {
    return this.getAttribute("name") ?? "";
  }

  set name(value: string) {
    this.setAttribute("name", value);
  }

  get form(): FakeHTMLFormElement | null {
    return this.closest("form") as FakeHTMLFormElement | null;
  }
}

/** Shared text-field behaviour for `<input>` and `<textarea>`. */
class TextFieldElement extends FormControlElement {
  checked = false;
  files: readonly File[] | null = null;
  selectionEnd: number | null = null;
  selectionStart: number | null = null;
  private inputValue: string | null = null;

  get defaultValue(): string {
    return this.getAttribute("value") ?? "";
  }

  get value(): string {
    return this.inputValue ?? this.defaultValue;
  }

  set value(next: string) {
    this.inputValue = String(next);
  }

  get placeholder(): string {
    return this.getAttribute("placeholder") ?? "";
  }

  set placeholder(value: string) {
    this.setAttribute("placeholder", value);
  }

  get type(): string {
    return this.getAttribute("type") ?? "text";
  }

  set type(value: string) {
    this.setAttribute("type", value);
  }

  reset(): void {
    this.inputValue = null;
    this.checked = this.hasAttribute("checked");
  }

  setRangeText(
    replacement: string,
    start: number,
    end: number,
    selectionMode?: string
  ): void {
    const current = this.value;
    this.value =
      current.substring(0, start) + replacement + current.substring(end);
    if (selectionMode === "end") {
      this.selectionStart = start + replacement.length;
      this.selectionEnd = this.selectionStart;
    }
  }
}

export class FakeHTMLInputElement extends TextFieldElement {}

export class FakeHTMLTextAreaElement extends TextFieldElement {}

export class FakeHTMLOptionElement extends FakeHTMLElement {
  disabled = false;

  get value(): string {
    return this.getAttribute("value") ?? this.textContent;
  }

  set value(next: string) {
    this.setAttribute("value", next);
  }

  get text(): string {
    return this.textContent;
  }

  set text(next: string) {
    this.textContent = next;
  }
}

export class FakeHTMLSelectElement extends FormControlElement {
  private selectValue: string | null = null;

  get options(): FakeHTMLOptionElement[] {
    return this.querySelectorAll("option") as FakeHTMLOptionElement[];
  }

  /** Matches the browser: an unmatched assignment clears the value. */
  get value(): string {
    if (this.selectValue !== null) {
      return this.selectValue;
    }
    const options = this.options;
    return options.length > 0 ? options[0].value : "";
  }

  set value(next: string) {
    const value = String(next);
    const options = this.options;
    if (options.length === 0) {
      this.selectValue = value;
      return;
    }
    this.selectValue = options.some((option) => option.value === value)
      ? value
      : "";
  }

  reset(): void {
    this.selectValue = null;
  }
}

export class FakeHTMLButtonElement extends FormControlElement {
  get type(): string {
    return this.getAttribute("type") ?? "submit";
  }

  set type(value: string) {
    this.setAttribute("type", value);
  }

  get value(): string {
    return this.getAttribute("value") ?? "";
  }

  set value(next: string) {
    this.setAttribute("value", next);
  }
}

export type SettingControlElement =
  | FakeHTMLButtonElement
  | FakeHTMLInputElement
  | FakeHTMLSelectElement;

/** Array-like `HTMLFormControlsCollection` stand-in with `namedItem`. */
class FormControlsCollection extends Array<SettingControlElement> {
  namedItem(name: string): SettingControlElement | null {
    return this.find((control) => control.name === name) ?? null;
  }
}

export class FakeHTMLFormElement extends FakeHTMLElement {
  get elements(): FormControlsCollection {
    const controls = this.querySelectorAll("input, select, button, textarea");
    return FormControlsCollection.from(
      controls as SettingControlElement[]
    ) as FormControlsCollection;
  }

  requestSubmit(): void {
    this.dispatchEvent(new DomEvent("submit", { cancelable: true }));
  }

  reset(): void {
    for (const control of this.elements) {
      if (
        control instanceof FakeHTMLInputElement ||
        control instanceof FakeHTMLSelectElement
      ) {
        control.reset();
      }
    }
    this.dispatchEvent(new DomEvent("reset"));
  }
}

export class FakeHTMLDetailsElement extends FakeHTMLElement {
  get open(): boolean {
    return this.hasAttribute("open");
  }

  set open(value: boolean) {
    if (value) {
      this.setAttribute("open", "");
    } else {
      this.removeAttribute("open");
    }
  }
}

export class FakeHTMLAnchorElement extends FakeHTMLElement {
  download = "";

  get href(): string {
    return this.getAttribute("href") ?? "";
  }

  set href(value: string) {
    this.setAttribute("href", value);
  }
}

export class FakeHTMLCanvasElement extends FakeHTMLElement {
  height = 150;
  width = 300;

  getContext(type: string, options?: unknown): unknown {
    return activeContextFactory?.(type, options, this) ?? null;
  }
}

const TAG_CLASSES: Record<string, new (tag: string) => FakeHTMLElement> = {
  a: FakeHTMLAnchorElement,
  button: FakeHTMLButtonElement,
  canvas: FakeHTMLCanvasElement,
  details: FakeHTMLDetailsElement,
  form: FakeHTMLFormElement,
  input: FakeHTMLInputElement,
  option: FakeHTMLOptionElement,
  select: FakeHTMLSelectElement,
  textarea: FakeHTMLTextAreaElement,
};

function createElementFor(tag: string): FakeHTMLElement {
  const Ctor = TAG_CLASSES[tag.toLowerCase()] ?? FakeHTMLElement;
  return new Ctor(tag);
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

function parseAttributes(source: string, element: FakeElement): void {
  const pattern = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    element.setAttribute(name, value);
    if (name.startsWith("data-")) {
      const key = name
        .substring(5)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      (element as FakeHTMLElement).dataset[key] = value;
    }
  }
}

/** Parses the subset of HTML the page sources use into a detached tree. */
export function parseHtml(html: string): FakeHTMLElement {
  const root = new FakeHTMLElement("body");
  const stack: FakeHTMLElement[] = [root];
  let index = 0;

  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next === -1) {
      appendText(stack, html.substring(index));
      break;
    }
    if (next > index) {
      appendText(stack, html.substring(index, next));
    }
    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", next)) {
      const end = html.indexOf(">", next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    const end = findTagEnd(html, next);
    const raw = html.substring(next + 1, end);
    index = end + 1;

    if (raw.startsWith("/")) {
      const name = raw.substring(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].tagName.toLowerCase() === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const nameMatch = raw.match(/^([a-z][\w-]*)/i);
    if (!nameMatch) {
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const element = createElementFor(tag);
    parseAttributes(raw.substring(tag.length).replace(/\/$/, ""), element);
    stack[stack.length - 1].appendChild(element);

    if (RAW_TEXT_TAGS.has(tag)) {
      // Script and style bodies are never executed nor matched against, so the
      // raw text is skipped rather than parsed as markup.
      const close = html.toLowerCase().indexOf(`</${tag}`, index);
      index = close === -1 ? html.length : findTagEnd(html, close) + 1;
      continue;
    }
    if (!(VOID_TAGS.has(tag) || raw.endsWith("/"))) {
      stack.push(element);
    }
  }
  return root;
}

/** Finds the `>` closing a tag, ignoring any inside quoted attributes. */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let at = start + 1; at < html.length; at++) {
    const char = html[at];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return at;
    }
  }
  return html.length;
}

function appendText(stack: FakeHTMLElement[], text: string): void {
  if (text.trim() === "") {
    return;
  }
  stack[stack.length - 1].appendChild(new FakeText(decodeEntities(text)));
}

// ---------------------------------------------------------------------------
// Document, window, and the virtual clock
// ---------------------------------------------------------------------------

interface VirtualTimer {
  callback: () => void;
  due: number;
  id: number;
  kind: "frame" | "idle" | "timeout";
}

class FakeDocument extends FakeNode {
  activeElement: FakeHTMLElement | null = null;
  readonly body: FakeHTMLElement;
  cookie = "";
  readonly documentElement: FakeHTMLElement;
  visibilityState = "visible";

  constructor(root: FakeHTMLElement) {
    super();
    this.documentElement = new FakeHTMLElement("html");
    this.body = root;
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag: string): FakeHTMLElement {
    return createElementFor(tag);
  }

  createTextNode(data: string): FakeText {
    return new FakeText(data);
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.matches(selector)
      ? this.documentElement
      : this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
}

export type CanvasContextFactory = (
  type: string,
  options: unknown,
  canvas: FakeHTMLCanvasElement
) => unknown;

let activeDocument: FakeDocument | null = null;
let activeContextFactory: CanvasContextFactory | null = null;

/** A stand-in for the popup `window.open` hands back. */
export interface FakeChildWindow {
  closed: boolean;
  close: () => void;
  location: { href: string };
  /** Every href assigned to this window, in order. */
  navigations: string[];
  /** Called on each navigation, so a test can answer with a postMessage. */
  onNavigate?: (url: string, target: FakeChildWindow) => void;
}

export interface ResizeObserverStub {
  disconnect: () => void;
  observe: (target: unknown) => void;
  trigger: () => void;
  unobserve: (target: unknown) => void;
}

export interface InstallDomOptions {
  /** Page markup; defaults to an empty body. */
  html?: string;
  /** Overrides `navigator.userAgent`. */
  userAgent?: string;
  /** Value reported by `matchMedia("(prefers-reduced-motion: reduce)")`. */
  reducedMotion?: boolean;
  /** Return value for `window.confirm`. */
  confirm?: boolean | (() => boolean);
  /** Supplies canvas contexts; returns `null` by default. */
  canvasContext?: CanvasContextFactory;
  /** Initial `location` href. */
  url?: string;
  /** `serviceWorker` value on the fake navigator; omitted when absent. */
  serviceWorker?: unknown;
  /** Whether `requestIdleCallback` exists on `window`. */
  idleCallback?: boolean;
  devicePixelRatio?: number;
  computedStyle?: Record<string, string>;
  /** Value of the global `crossOriginIsolated` flag. */
  crossOriginIsolated?: boolean;
  /** Value of `document.visibilityState`. */
  visibilityState?: string;
}

export interface FakeLocation {
  assign: (url: string) => void;
  hash: string;
  href: string;
  origin: string;
  pathname: string;
  search: string;
}

/** The fake `window`: an event target carrying the browser globals. */
export type WindowLike = FakeNode & Record<string, unknown>;

/**
 * The fake document, surfaced as the real `Document` type so tests can use
 * ordinary DOM types. `visibilityState` stays writable for the benchmark page.
 */
export type TestDocument = Omit<Document, "visibilityState"> & {
  visibilityState: string;
};

export interface DomHandle {
  /** Advances the virtual clock, firing timers and frames in order. */
  advance: (ms: number) => Promise<void>;
  assignedUrls: string[];
  confirmCalls: string[];
  document: TestDocument;
  /** Dispatches a window-scoped event such as `beforeunload`. */
  fireWindow: (type: string, init?: Record<string, unknown>) => DomEvent;
  location: FakeLocation;
  navigator: Record<string, unknown>;
  /** Windows handed out by `window.open`, newest last. */
  openedWindows: FakeChildWindow[];
  /** How many times `location.reload` was called. */
  reloads: () => number;
  replacedStates: string[];
  resizeObservers: ResizeObserverStub[];
  restore: () => void;
  /** Runs every queued animation frame callback once. */
  runFrames: () => boolean;
  /** Runs pending microtasks, frames, and already-due timers. */
  settle: () => Promise<void>;
  window: WindowLike;
}

const INSTALLED_GLOBALS = [
  "document",
  "window",
  "navigator",
  "location",
  "history",
  "Node",
  "Text",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "HTMLOptionElement",
  "HTMLFormElement",
  "HTMLDetailsElement",
  "HTMLAnchorElement",
  "HTMLCanvasElement",
  "Event",
  "KeyboardEvent",
  "PointerEvent",
  "MouseEvent",
  "FormData",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "setTimeout",
  "clearTimeout",
  "matchMedia",
  "confirm",
  "crossOriginIsolated",
  "sessionStorage",
  "MessageChannel",
] as const;

/**
 * Installs the fake DOM on `globalThis` and returns a handle for driving it.
 * Always call `restore()` in `afterEach`.
 */
export function installDom(options: InstallDomOptions = {}): DomHandle {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, { present: boolean; value: unknown }>();
  for (const name of INSTALLED_GLOBALS) {
    saved.set(name, { present: name in globals, value: globals[name] });
  }
  const savedPerformanceNow = performance.now;

  const document = new FakeDocument(parseHtml(options.html ?? ""));
  document.visibilityState = options.visibilityState ?? "visible";
  activeDocument = document;
  activeContextFactory = options.canvasContext ?? null;

  // --- virtual clock -------------------------------------------------------
  let now = 0;
  let nextTimerId = 1;
  let timers: VirtualTimer[] = [];
  const schedule = (
    callback: () => void,
    delay: number,
    kind: VirtualTimer["kind"]
  ): number => {
    const id = nextTimerId++;
    timers.push({ callback, due: now + Math.max(0, delay || 0), id, kind });
    return id;
  };
  const cancel = (id: unknown): void => {
    timers = timers.filter((timer) => timer.id !== id);
  };
  // Captured before the global override so settling can still yield to the real
  // event loop, which is how `MessagePort` messages get delivered.
  const realSetTimeout = globalThis.setTimeout;
  const drainMicrotasks = async (): Promise<void> => {
    for (let pass = 0; pass < 4; pass++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    for (let pass = 0; pass < 4; pass++) {
      await Promise.resolve();
    }
  };
  const runFrames = (): boolean => {
    const frames = timers.filter((timer) => timer.kind !== "timeout");
    if (frames.length === 0) {
      return false;
    }
    timers = timers.filter((timer) => timer.kind === "timeout");
    for (const frame of frames) {
      frame.callback();
    }
    return true;
  };
  const fireDueTimers = (): boolean => {
    const due = timers
      .filter((timer) => timer.kind === "timeout" && timer.due <= now)
      .sort((left, right) => left.due - right.due || left.id - right.id);
    if (due.length === 0) {
      return false;
    }
    for (const timer of due) {
      cancel(timer.id);
      timer.callback();
    }
    return true;
  };
  const settle = async (): Promise<void> => {
    for (let pass = 0; pass < 40; pass++) {
      await drainMicrotasks();
      const ranFrames = runFrames();
      const ranTimers = fireDueTimers();
      if (!(ranFrames || ranTimers)) {
        return;
      }
    }
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + Math.max(0, ms);
    await settle();
    for (let pass = 0; pass < 200; pass++) {
      const pending = timers
        .filter((timer) => timer.kind === "timeout" && timer.due <= target)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (!pending) {
        break;
      }
      now = Math.max(now, pending.due);
      await settle();
    }
    now = Math.max(now, target);
    await settle();
  };

  // --- window, location, navigator ----------------------------------------
  const assignedUrls: string[] = [];
  const replacedStates: string[] = [];
  const confirmCalls: string[] = [];
  const initialUrl = new URL(options.url ?? "https://flashbang.test/");
  const location = {
    assign(url: string) {
      assignedUrls.push(url);
    },
    reload() {
      reloads++;
    },
    href: initialUrl.href,
    origin: initialUrl.origin,
    pathname: initialUrl.pathname,
    search: initialUrl.search,
    hash: initialUrl.hash,
  };
  const history = {
    replaceState(_state: unknown, _title: string, url: string) {
      replacedStates.push(url);
      location.pathname = url;
    },
  };
  const openedWindows: FakeChildWindow[] = [];
  let reloads = 0;
  /** Replaced by a test that needs `window.open` to fail. */
  const openWindow: (url: string) => FakeChildWindow | null = () => {
    const child: FakeChildWindow = {
      closed: false,
      close() {
        child.closed = true;
      },
      location: {
        get href() {
          return child.navigations.at(-1) ?? "about:blank";
        },
        set href(value: string) {
          child.navigations.push(value);
          child.onNavigate?.(value, child);
        },
      },
      navigations: [],
    };
    openedWindows.push(child);
    return child;
  };
  const sessionStore = new Map<string, string>();
  const sessionStorage = {
    clear: () => sessionStore.clear(),
    getItem: (key: string) => sessionStore.get(key) ?? null,
    removeItem: (key: string) => sessionStore.delete(key),
    setItem: (key: string, value: string) => {
      sessionStore.set(key, String(value));
    },
  };
  const resizeObservers: ResizeObserverStub[] = [];
  class ResizeObserverImpl implements ResizeObserverStub {
    private readonly callback: () => void;

    constructor(callback: () => void) {
      this.callback = callback;
      resizeObservers.push(this);
    }

    disconnect(): void {
      /* Nothing is tracked; tests trigger callbacks explicitly. */
    }

    observe(): void {
      /* Nothing is tracked; tests trigger callbacks explicitly. */
    }

    trigger(): void {
      this.callback();
    }

    unobserve(): void {
      /* Nothing is tracked; tests trigger callbacks explicitly. */
    }
  }

  const confirmResult = options.confirm ?? true;
  const confirmFn = (message?: string): boolean => {
    confirmCalls.push(String(message ?? ""));
    return typeof confirmResult === "function"
      ? confirmResult()
      : confirmResult;
  };
  const computedStyle = options.computedStyle ?? {
    fontFamily: "system-ui",
    fontSize: "128px",
    fontWeight: "800",
  };

  /**
   * `FormData` over the fake form elements. Only the accessors the settings
   * form uses are implemented; a real `FormData` cannot read a fake form.
   */
  class FormDataShim {
    private readonly entries = new Map<string, string>();

    constructor(form?: unknown) {
      if (form === undefined) {
        return;
      }
      if (!(form instanceof FakeHTMLFormElement)) {
        throw new TypeError(
          "The test FormData only accepts a form from the fake DOM"
        );
      }
      for (const control of form.elements) {
        if (control.name && !(control instanceof FakeHTMLButtonElement)) {
          this.entries.set(control.name, control.value);
        }
      }
    }

    append(name: string, value: string): void {
      this.entries.set(name, value);
    }

    get(name: string): string | null {
      return this.entries.get(name) ?? null;
    }

    has(name: string): boolean {
      return this.entries.has(name);
    }

    set(name: string, value: string): void {
      this.entries.set(name, value);
    }
  }

  const timeoutFn = (callback: () => void, delay?: number): number =>
    schedule(callback, delay ?? 0, "timeout");
  // `window` keeps its own listener registry so that window-scoped events such
  // as `beforeunload` do not leak into `document` listeners.
  const windowTarget = new FakeNode();
  const window = Object.assign(windowTarget as unknown as WindowLike, {
    cancelAnimationFrame: cancel,
    clearTimeout: cancel,
    confirm: confirmFn,
    devicePixelRatio: options.devicePixelRatio ?? 1,
    document,
    getComputedStyle: () => computedStyle,
    history,
    location,
    matchMedia: (query: string) => ({
      matches: query.includes("prefers-reduced-motion")
        ? Boolean(options.reducedMotion)
        : false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    requestAnimationFrame: (callback: (time: number) => void): number =>
      schedule(() => callback(now), 0, "frame"),
    setTimeout: timeoutFn,
    open: (url = "about:blank") => openWindow(url),
    sessionStorage,
    ResizeObserver: ResizeObserverImpl,
  });
  if (options.idleCallback !== false) {
    window.requestIdleCallback = (callback: () => void): number =>
      schedule(callback, 0, "idle");
  }
  const navigator: Record<string, unknown> = {
    userAgent: options.userAgent ?? "Mozilla/5.0 (Test) Chrome/120",
    clipboard: { writeText: () => Promise.resolve() },
  };
  if (options.serviceWorker !== undefined) {
    navigator.serviceWorker = options.serviceWorker;
  }

  const assignments: Record<string, unknown> = {
    document,
    window,
    navigator,
    location,
    history,
    Node: FakeNode,
    Text: FakeText,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    HTMLSelectElement: FakeHTMLSelectElement,
    HTMLButtonElement: FakeHTMLButtonElement,
    HTMLOptionElement: FakeHTMLOptionElement,
    HTMLFormElement: FakeHTMLFormElement,
    HTMLDetailsElement: FakeHTMLDetailsElement,
    HTMLAnchorElement: FakeHTMLAnchorElement,
    HTMLCanvasElement: FakeHTMLCanvasElement,
    Event: DomEvent,
    KeyboardEvent: DomKeyboardEvent,
    PointerEvent: DomEvent,
    MouseEvent: DomEvent,
    FormData: FormDataShim,
    ResizeObserver: ResizeObserverImpl,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: cancel,
    setTimeout: timeoutFn,
    clearTimeout: cancel,
    matchMedia: window.matchMedia,
    confirm: confirmFn,
    crossOriginIsolated: options.crossOriginIsolated ?? true,
    sessionStorage,
  };
  if (options.idleCallback !== false) {
    assignments.requestIdleCallback = window.requestIdleCallback;
  }
  for (const [name, value] of Object.entries(assignments)) {
    Object.defineProperty(globals, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  performance.now = () => now;

  return {
    advance,
    assignedUrls,
    confirmCalls,
    document: document as unknown as TestDocument,
    fireWindow(type: string, init: Record<string, unknown> = {}): DomEvent {
      const event = new DomEvent(type, { cancelable: true, ...init });
      windowTarget.dispatchEvent(event);
      return event;
    },
    location,
    navigator,
    openedWindows,
    reloads: () => reloads,
    replacedStates,
    resizeObservers,
    runFrames,
    settle,
    window,
    restore() {
      for (const [name, entry] of saved) {
        if (entry.present) {
          Object.defineProperty(globals, name, {
            configurable: true,
            writable: true,
            value: entry.value,
          });
        } else {
          delete globals[name];
        }
      }
      performance.now = savedPerformanceNow;
      activeDocument = null;
      activeContextFactory = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Page fixtures and canvas stubs
// ---------------------------------------------------------------------------

/**
 * Reads the real home page markup, the fixture for home and settings UI.
 * The custom suggestion provider option is injected at build time, so the same
 * transform runs here; pass `false` to model a build with it disabled.
 */
export async function readHomeHtml(customSuggest = true): Promise<string> {
  const { configureCustomSuggestOption } = await import("../../scripts/shared");
  return configureCustomSuggestOption(
    await Bun.file("src/ui/home/index.html").text(),
    customSuggest
  );
}

/** Reads the real benchmark page markup. */
export function readBenchHtml(): Promise<string> {
  return Bun.file("src/ui/bench/index.html").text();
}

export interface RecordedCall {
  args: unknown[];
  name: string;
}

/** A permissive 2D context capturing the calls `liquid-metal` makes. */
export function create2DContextStub(size = 64): Record<string, unknown> {
  const pixels = new Uint8ClampedArray(size * size * 4).fill(128);
  return {
    fillRect: () => undefined,
    fillText: () => undefined,
    filter: "none",
    fillStyle: "#000",
    font: "",
    getImageData: () => ({ data: pixels, height: size, width: size }),
    measureText: () => ({
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 20,
    }),
    scale: () => undefined,
    textAlign: "left",
    textBaseline: "alphabetic",
  };
}

export interface WebGL2Stub {
  calls: RecordedCall[];
  context: Record<string, unknown>;
}

/**
 * A WebGL2 context stub. Unknown methods record and return an opaque handle,
 * and unknown `SCREAMING_CASE` members resolve to distinct numeric constants,
 * so the shader path runs without a GPU.
 */
export function createWebGL2Stub(
  overrides: Record<string, unknown> = {}
): WebGL2Stub {
  const calls: RecordedCall[] = [];
  let nextConstant = 1;
  const constants = new Map<string, number>();
  const cache = new Map<string, unknown>();
  const target: Record<string, unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getAttribLocation: () => 0,
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    ...overrides,
  };

  const context = new Proxy(target, {
    get(_source, property) {
      const name = String(property);
      if (name in target) {
        return target[name];
      }
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
        if (!constants.has(name)) {
          constants.set(name, nextConstant++);
        }
        return constants.get(name);
      }
      if (!cache.has(name)) {
        cache.set(name, (...args: unknown[]) => {
          calls.push({ args, name });
          return { handle: name };
        });
      }
      return cache.get(name);
    },
    has() {
      return true;
    },
  });

  return { calls, context: context as Record<string, unknown> };
}

/** Canvas factory returning a 2D stub plus the given WebGL2 behaviour. */
export function canvasContextFactory(
  webgl: Record<string, unknown> | null
): CanvasContextFactory {
  return (type) => {
    if (type === "2d") {
      return create2DContextStub();
    }
    return type === "webgl2" ? webgl : null;
  };
}

/**
 * Sets the layout box a test depends on. Nothing computes layout here, so the
 * offset metrics are plain writable fields behind the read-only DOM types.
 */
export function setElementSize(
  element: unknown,
  width: number,
  height = width
): void {
  const target = element as { offsetHeight: number; offsetWidth: number };
  target.offsetWidth = width;
  target.offsetHeight = height;
}

/** Dispatches a keyboard event, defaulting to the shape UI handlers read. */
export function pressKey(
  target: unknown,
  key: string,
  init: Record<string, unknown> = {}
): DomKeyboardEvent {
  const event = new DomKeyboardEvent("keydown", {
    bubbles: true,
    key,
    ...init,
  });
  (target as FakeNode).dispatchEvent(event);
  return event;
}

/** Fires a bubbling event of `type` on `target`. */
export function fire(
  target: unknown,
  type: string,
  init: Record<string, unknown> = {}
): DomEvent {
  const event = new DomEvent(type, { bubbles: true, ...init });
  (target as FakeNode).dispatchEvent(event);
  return event;
}
