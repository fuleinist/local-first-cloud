// Minimal XML helpers: escaping, tag building, S3 error documents, and a
// tiny parser for the specific request bodies we accept (DeleteObjects).

const ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

export function unesc(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// tag('Key', 'a/b')            -> <Key>a/b</Key>
// tag('Key', 'a', {})          -> <Key>a</Key>
// tag('Bucket', null, {x:'1'}) -> <Bucket x="1"/>
export function tag(name, content, attrs) {
  let attrStr = '';
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      attrStr += ` ${k}="${esc(v)}"`;
    }
  }
  if (content === undefined || content === null) return `<${name}${attrStr}/>`;
  return `<${name}${attrStr}>${content}</${name}>`;
}

export function xmlDoc(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

export function errorXml({ code, message, resource = '', requestId = '' }) {
  return xmlDoc(
    tag('Error', [
      tag('Code', esc(code)),
      tag('Message', esc(message)),
      resource ? tag('Resource', esc(resource)) : '',
      requestId ? tag('RequestId', esc(requestId)) : '',
    ].join(''))
  );
}

// Extract text content of all <name>...</name> elements (non-nested).
export function extractAll(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(unesc(m[1]));
  return out;
}

export function extractOne(xml, name) {
  const all = extractAll(xml, name);
  return all.length ? all[0] : undefined;
}

// Parse a DeleteObjects request body -> { quiet: bool, keys: string[] }
export function parseDeleteBody(xml) {
  const quiet = /<Quiet\s*\/>|<Quiet>\s*true\s*<\/Quiet>/i.test(xml || '');
  const keys = extractAll(xml || '', 'Key');
  return { quiet, keys };
}
