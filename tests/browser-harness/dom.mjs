// Minimal DOM boundary for deterministic controller tests. This does not model
// browser layout/CSS, extension isolated worlds, or actual media decoding.
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export class EventTargetMock {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    if (typeof event === 'string') event = { type: event };
    event.target ||= this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener.call(this, event);
    return !event.defaultPrevented;
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, value) => sum + value.size, 0); }
}

class StyleMock {
  constructor() { this.values = new Map(); }
  setProperty(property, value) { this.values.set(property, String(value)); }
  getPropertyValue(property) { return this.values.get(property) || ''; }
  removeProperty(property) { const old = this.getPropertyValue(property); this.values.delete(property); return old; }
}

function matches(element, selector) {
  if (selector.includes(',')) return selector.split(',').some(part => matches(element, part.trim()));
  if (selector === '*') return true;
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('#')) return element.getAttribute('id') === selector.slice(1);
  const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(selector);
  if (attribute) return element.hasAttribute(attribute[1]) && (attribute[2] === undefined || element.getAttribute(attribute[1]) === attribute[2]);
  return element.tagName === selector.toUpperCase();
}

export class ElementMock extends EventTargetMock {
  constructor(tagName, document) {
    super(); this.tagName = tagName.toUpperCase(); this.ownerDocument = document; this.nodeType = 1;
    this.children = []; this.parentNode = null; this.attributes = new Map();
    this.style = new StyleMock(); this.className = ''; this.hidden = false; this._text = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const add = force === undefined ? !names.has(name) : force;
        if (add) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
        return Boolean(add);
      }
    };
    this.rect = { left: 10, top: 20, width: 640, height: 360, right: 650, bottom: 380 };
  }
  get parentElement() { return this.parentNode instanceof ElementMock ? this.parentNode : null; }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get isConnected() { return Boolean(this.parentNode?.isConnected); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = String(value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
  contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
  closest(selector) { for (let node = this; node instanceof ElementMock; node = node.parentElement) if (matches(node, selector)) return node; return null; }
  matches(selector) { return matches(this, selector); }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (matches(child, selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  attachShadow() {
    const shadow = new ShadowRootMock(this, this.ownerDocument);
    this.shadowRoot = shadow;
    return shadow;
  }
  getBoundingClientRect() { return this.rect; }
}

class ShadowRootMock extends ElementMock {
  constructor(host, document) { super('#shadow-root', document); this.host = host; }
  get isConnected() { return this.host.isConnected; }
}

export class VideoMock extends ElementMock {
  constructor(document) {
    super('video', document); this.currentTime = 0; this.playbackRate = 1; this.paused = true;
    this.ended = false; this.textTracks = []; this._frameId = 0; this.frames = new Map(); this.allFrames = new Map();
  }
  requestVideoFrameCallback(callback) {
    const id = ++this._frameId; this.frames.set(id, callback); this.allFrames.set(id, callback); return id;
  }
  cancelVideoFrameCallback(id) { this.frames.delete(id); }
  fireFrame(id, mediaTime = this.currentTime) {
    const callback = this.allFrames.get(id); this.frames.delete(id); callback?.(0, { mediaTime });
  }
}

class DocumentMock extends EventTargetMock {
  constructor() {
    super(); this.isConnected = true; this.children = []; this.hidden = false; this.fullscreenElement = null; this.nodeType = 9;
    this.documentElement = new ElementMock('html', this); this.documentElement.parentNode = this;
    this.children.push(this.documentElement);
    this.head = new ElementMock('head', this); this.body = new ElementMock('body', this);
    this.documentElement.append(this.head, this.body);
  }
  createElement(tagName) { return tagName.toLowerCase() === 'video' ? new VideoMock(this) : new ElementMock(tagName, this); }
  querySelectorAll(selector) { return [...(matches(this.documentElement, selector) ? [this.documentElement] : []), ...this.documentElement.querySelectorAll(selector)]; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return this.querySelector('#' + id); }
}

export async function makeEnvironment() {
  const document = new DocumentMock();
  const events = new EventTargetMock();
  let animationId = 0;
  const animations = new Map();
  const context = vm.createContext({
    console, document, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    requestAnimationFrame: callback => { const id = ++animationId; animations.set(id, callback); return id; },
    cancelAnimationFrame: id => animations.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} }
  });
  for (const filename of ['subtitles/core.js', 'subtitles/controller.js']) {
    vm.runInContext(await readFile(resolve(rootPath, filename), 'utf8'), context, { filename });
  }
  return { context, document, events, animations };
}
