#!/usr/bin/env node
// Regenerates the README "Current Scope" block from the endpoint catalog.
// CI regenerates and diffs this file, so a typed-command change that forgets
// to run `npm run readme:scope` fails the build (same pattern as the
// coverage-dashboard drift check).
const fs = require('fs');
const path = require('path');
const { endpointDefinitions, commandLiteralPrefix } = require('../src/catalog');

const README_PATH = path.resolve(__dirname, '..', 'README.md');
const BEGIN = '<!-- BEGIN GENERATED: current-scope (npm run readme:scope) -->';
const END = '<!-- END GENERATED: current-scope -->';

function areaSummaries() {
  const areas = new Map();
  for (const definition of endpointDefinitions()) {
    if (definition.status !== 'typed' || !definition.command) continue;
    const tokens = commandLiteralPrefix(definition.command).split(/\s+/);
    const area = tokens.slice(1, -1).join(' ') || tokens[1];
    if (!areas.has(area)) areas.set(area, new Set());
    areas.get(area).add(commandLiteralPrefix(definition.command));
  }
  return [...areas.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([area, commands]) => `- \`hsapi ${area}\` — ${commands.size} command${commands.size === 1 ? '' : 's'}`);
}

function generatedBlock() {
  const definitions = endpointDefinitions().filter((definition) => definition.status === 'typed' && definition.command);
  const families = new Set(definitions.map((definition) => definition.family));
  const documented = definitions.filter((definition) => Array.isArray(definition.args)).length;
  return [
    BEGIN,
    '',
    `The catalog covers **${definitions.length} typed commands** across **${families.size} endpoint families**, every one with documented arguments (\`hsapi help <command>\`). Local tooling on top: multi-portal profiles, generic catalog-gated requests with previews, the MCP server (\`hsapi mcp serve\`), tier reporting, CMS/auth/project doctors, the mutation audit log (\`hsapi history\`), and \`hsapi upgrade\`.`,
    '',
    ...areaSummaries(),
    '',
    `Argspec coverage: ${documented}/${definitions.length} typed commands documented.`,
    '',
    END
  ].join('\n');
}

const readme = fs.readFileSync(README_PATH, 'utf8');
let next;
if (readme.includes(BEGIN) && readme.includes(END)) {
  const before = readme.slice(0, readme.indexOf(BEGIN));
  const after = readme.slice(readme.indexOf(END) + END.length);
  next = before + generatedBlock() + after;
} else {
  const heading = '## Current Scope';
  const start = readme.indexOf(heading);
  if (start === -1) {
    console.error('README.md is missing the "## Current Scope" heading.');
    process.exit(1);
  }
  const afterHeading = start + heading.length;
  const nextHeading = readme.indexOf('\n## ', afterHeading);
  const tail = nextHeading === -1 ? '' : readme.slice(nextHeading);
  next = `${readme.slice(0, afterHeading)}\n\n${generatedBlock()}\n${tail}`;
}
fs.writeFileSync(README_PATH, next);
console.log(README_PATH);
