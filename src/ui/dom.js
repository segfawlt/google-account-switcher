// @ts-check

/**
 * Create a DOM element safely without `innerHTML` assignments (`web-ext lint` clean).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string | boolean | number | null | undefined>} [attrs]
 * @param {Array<Node | string | null | undefined>} [children]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs = {}, children = []) {
  const elem = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val === undefined || val === null || val === false) continue;
    if (key === "className") {
      elem.className = String(val);
    } else if (val === true) {
      elem.setAttribute(key, "");
    } else {
      elem.setAttribute(key, String(val));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    elem.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return elem;
}

/**
 * Replace all children of a container safely.
 * @param {HTMLElement} container
 * @param {...(Node | string | null | undefined)} nodes
 */
export function replaceChildrenSafe(container, ...nodes) {
  const filtered = /** @type {Array<Node | string>} */ (
    nodes.filter((n) => n !== null && n !== undefined)
  );
  container.replaceChildren(...filtered);
}
