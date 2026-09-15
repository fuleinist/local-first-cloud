import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, unesc, tag, errorXml, extractAll, extractOne, parseDeleteBody } from '../lib/xml.js';

test('esc escapes XML entities', () => {
  assert.equal(esc('a<b>&c"d\'e'), 'a&lt;b&gt;&amp;c&quot;d&apos;e');
  assert.equal(esc('plain/key-1.txt'), 'plain/key-1.txt');
});

test('unesc round-trips', () => {
  const s = 'weird <>&"\' chars';
  assert.equal(unesc(esc(s)), s);
  assert.equal(unesc('&#65;&#x42;'), 'AB');
});

test('tag builds elements (content is caller-escaped, may nest tags)', () => {
  assert.equal(tag('Key', 'a/b'), '<Key>a/b</Key>');
  assert.equal(tag('Empty', null), '<Empty/>');
  assert.equal(tag('B', 'x', { n: '1' }), '<B n="1">x</B>');
  assert.equal(tag('B', esc('<x>')), '<B>&lt;x&gt;</B>');
  assert.equal(tag('Outer', tag('Inner', 'v')), '<Outer><Inner>v</Inner></Outer>');
  assert.equal(tag('B', 'x', { n: '<1' }), '<B n="&lt;1">x</B>'); // attrs are escaped
});

test('errorXml is well-formed', () => {
  const xml = errorXml({ code: 'NoSuchKey', message: 'gone & forgotten', resource: '/b/k' });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<Code>NoSuchKey</Code>'));
  assert.ok(xml.includes('gone &amp; forgotten'));
  assert.ok(xml.includes('<Resource>/b/k</Resource>'));
});

test('extractAll/extractOne pull values', () => {
  const xml = '<Delete><Object><Key>a b.txt</Key></Object><Object><Key>c&amp;d</Key></Object></Delete>';
  assert.deepEqual(extractAll(xml, 'Key'), ['a b.txt', 'c&d']);
  assert.equal(extractOne(xml, 'Key'), 'a b.txt');
  assert.equal(extractOne(xml, 'Missing'), undefined);
});

test('parseDeleteBody extracts keys and quiet', () => {
  const xml = '<?xml version="1.0"?><Delete><Quiet>true</Quiet><Object><Key>one</Key></Object><Object><Key>two/three</Key></Object></Delete>';
  const parsed = parseDeleteBody(xml);
  assert.equal(parsed.quiet, true);
  assert.deepEqual(parsed.keys, ['one', 'two/three']);
  assert.deepEqual(parseDeleteBody('<Delete><Object><Key>x</Key></Object></Delete>').keys, ['x']);
  assert.equal(parseDeleteBody('<Delete><Object><Key>x</Key></Object></Delete>').quiet, false);
});
