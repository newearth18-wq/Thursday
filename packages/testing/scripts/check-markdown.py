"""Reads a Markdown note the way Obsidian does, with an independent YAML
parser (PyYAML), and prints what it found as JSON: the frontmatter (which
must be valid YAML), the body, and the [[wikilinks]]. Used by the SET 11
tests to prove that notes Jupiter writes are valid.

    python3 check-markdown.py <note.md>
"""
import json
import re
import sys

import yaml


def main(path):
    raw = open(path, 'rb').read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    text = raw[3:].decode('utf-8') if bom else raw.decode('utf-8')
    frontmatter = None
    body = text
    match = re.match(r'^---\r?\n(.*?)\r?\n---(?:\r?\n|$)', text, re.S)
    if match:
        frontmatter = yaml.safe_load(match.group(1))
        if frontmatter is not None and not isinstance(frontmatter, dict):
            raise ValueError('The frontmatter is not a YAML mapping')
        body = text[match.end():]
    links = re.findall(r'\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]', body)
    print(json.dumps({
        'bom': bom,
        'frontmatter': frontmatter,
        'body': body,
        'links': links,
        'crlf': '\r\n' in text,
    }, default=str, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1])
