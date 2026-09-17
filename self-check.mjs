/**
 * Runnable check for the parts of Notible Graph that can be wrong silently:
 * wikilink resolution against untrusted titles, what counts as a crossing
 * link, and a layout that must be finite and the same on every open.
 *
 * node plugins/notible-graph/self-check.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import plugin, { boundsOf, buildGraph, canvasFor, crossingLinks, documentFrequency, hueOf, hueOfType, isGraphExcluded, keywordsOf, layout, LIVE_PHYSICS_MAX_NODES, MAX_RADIUS, nodeExit, radiusOf, reasonText, rootIdOf, semanticEdges, simulationStep, tagsOf, typeHues } from "./main.js";

// --- identity
const declared = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
assert.ok(plugin.manifest, "the entry module must export a manifest, not just onload");
for (const field of ["id", "name", "version", "apiVersion", "description", "author"]) {
  assert.equal(plugin.manifest[field], declared[field], `${field} must match plugin.json`);
}
assert.deepEqual(plugin.manifest.permissions, declared.permissions);
assert.equal(typeof plugin.onload, "function");
assert.equal(typeof plugin.onunload, "function");

// The plugin CALLS `ui.openView`, which arrived in API 1.8. Declaring 1.7
// would still load on a 1.8 host — the rule is same major, host minor at least
// the plugin's — and would then load on a 1.7 host too, where the method does
// not exist and the button dies on `undefined is not a function`. The declared
// version is what stops that, so it is asserted rather than assumed.
assert.equal(declared.apiVersion, "1.8", "openView is 1.8; a plugin that calls it must say so");

// The graph only ever reads. If this list ever grows a write permission,
// something has been added that the name of the plugin does not admit to.
assert.deepEqual([...declared.permissions].sort(), ["data.read", "workspace.ui"]);

// Szymon accepted this into the market as an alpha on the condition that it
// says so. The install screen shows the description, so the word lives there.
assert.ok(/ALPHA/i.test(declared.description), "the market entry must admit this is alpha");
assert.equal(declared.description, plugin.manifest.description);

// --- building the graph
const object = (id, over = {}) => ({ id, type: "note", title: id, parent_id: null, ...over });
const link = (from, value) => ({ object_id: from, kind: "link", value, level: null, checked: null, line: 0 });

const simple = buildGraph(
  [object("a"), object("b"), object("c", { parent_id: "a" })],
  [link("a", "b")],
);
assert.equal(simple.nodes.length, 3);
assert.deepEqual(simple.edges.filter((edge) => edge.kind === "link"), [{ from: "a", to: "b", kind: "link" }]);
assert.deepEqual(simple.edges.filter((edge) => edge.kind === "parent"), [{ from: "a", to: "c", kind: "parent" }]);
assert.equal(simple.nodes.find((node) => node.id === "c").free, false);
assert.equal(simple.nodes.find((node) => node.id === "b").free, true, "a note under nothing is flagged, not merely unlinked");

// Wikilink resolution is matching on a title typed by a human, so it has to be
// forgiving in exactly the ways a human is, and hard everywhere else.
assert.equal(buildGraph([object("a"), object("b", { title: "Design Notes" })], [link("a", "  design notes  ")]).edges.filter((edge) => edge.kind === "link").length, 1, "case and surrounding space do not matter");
assert.equal(buildGraph([object("a")], [link("a", "nothing here")]).edges.length, 0, "a link to a note that does not exist is dropped, not drawn to nowhere");
assert.equal(buildGraph([object("a")], [link("a", "a")]).edges.length, 0, "a note does not link to itself");
assert.equal(buildGraph([object("a"), object("b")], [link("a", "   ")]).edges.length, 0, "a whitespace target is not a link");
assert.equal(buildGraph([object("a"), object("b")], [{ object_id: "a", kind: "tag", value: "b" }]).edges.length, 0, "only link entries make link edges");
assert.equal(buildGraph([object("a"), object("b")], [link("ghost", "b")]).edges.length, 0, "an entry for an object we did not load is dropped");

// Untrusted input must not throw inside a render.
assert.deepEqual(buildGraph(null, null).nodes, []);
assert.deepEqual(buildGraph([null, undefined, {}], "not an array").nodes, [], "objects without an id are not nodes");
assert.equal(buildGraph([object("a", { title: null })], []).nodes[0].title, "Untitled");
assert.equal(buildGraph([object("a", { parent_id: "gone" })], []).nodes[0].free, true, "a parent outside the graph is no parent");
assert.equal(buildGraph([object("a", { parent_id: "gone" })], []).edges.length, 0, "and draws no dangling edge");

// One line per pair, however many times a note repeats the link.
const repeated = buildGraph([object("a"), object("b")], [link("a", "b"), link("a", "b"), link("b", "a")]);
assert.equal(repeated.edges.filter((edge) => edge.kind === "link").length, 1, "repeats and the reverse direction collapse to one line");
assert.equal(repeated.nodes.find((node) => node.id === "a").degree, 1, "and the dot is not inflated by them either");

// Two notes with the same title: pick one, and pick the SAME one every time,
// or the picture changes between two machines for no reason the user can see.
const colliding = [object("z", { title: "Same" }), object("a", { title: "Same" }), object("s")];
const first = buildGraph(colliding, [link("s", "Same")]).edges[0];
const second = buildGraph([...colliding].reverse(), [link("s", "Same")]).edges[0];
assert.deepEqual(first, second, "title collisions resolve the same way whatever order the objects arrive in");

// --- the thing the sidebar tree cannot show
const crossing = buildGraph(
  [object("p1"), object("p2"), object("n1", { parent_id: "p1" }), object("n2", { parent_id: "p2" }), object("n3", { parent_id: "p1" })],
  [link("n1", "n2"), link("n1", "n3")],
);
assert.deepEqual(crossingLinks(crossing).map((edge) => `${edge.from}->${edge.to}`), ["n1->n2"], "only the link leaving its container counts");
assert.equal(crossingLinks(buildGraph([object("a"), object("b")], [link("a", "b")])).length, 1, "two free notes are in different containers, not the same one");
// A cycle in parent_id can arrive by import or sync. Walking to the root must
// terminate rather than hang the modal.
const cyclic = buildGraph([object("a", { parent_id: "b" }), object("b", { parent_id: "a" })], [link("a", "b")]);
assert.equal(crossingLinks(cyclic).length, 0, "a parent cycle resolves instead of looping forever");

// --- the layout
const graph = buildGraph(
  [object("a"), object("b"), object("c", { parent_id: "a" }), object("d")],
  [link("a", "b")],
);
const placed = layout(graph, { width: 800, height: 600, iterations: 60 });
assert.equal(placed.length, 4);
for (const node of placed) {
  assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.id} must land at a real coordinate`);
}
// Determinism is the point: a graph that redraws differently on every open is
// not a map of anything. Positions are seeded from the ids, never from
// Math.random().
const again = layout(graph, { width: 800, height: 600, iterations: 60 });
assert.deepEqual(placed.map((node) => [node.x, node.y]), again.map((node) => [node.x, node.y]), "the same workspace draws the same picture twice");
assert.ok(!readFileSync(new URL("./main.js", import.meta.url), "utf8").includes("Math.random"), "Math.random would move every dot on every open");

// Two notes at the identical starting point have no direction to push apart
// in, and 0/0 poisons every later iteration with NaN.
const stacked = layout(buildGraph([object("x"), object("x2")], []), { width: 1, height: 1, iterations: 30 });
assert.ok(stacked.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)), "overlapping dots must not produce NaN");

assert.deepEqual(layout(buildGraph([], []), {}), [], "an empty workspace lays out to nothing rather than throwing");
const bounds = boundsOf(placed);
assert.ok(bounds.width > 0 && bounds.height > 0);
assert.ok(placed.every((node) => node.x >= bounds.x && node.x <= bounds.x + bounds.width), "the viewBox contains every node");
assert.deepEqual(boundsOf([]), { x: 0, y: 0, width: 100, height: 100 }, "an empty graph still has a valid viewBox");

// A hub must be bigger, but not a planet next to specks: the radius is
// clamped, and structural types (project, milestone…) start larger because
// they are the landmarks the graph is read by.
assert.ok(radiusOf({ degree: 0 }) >= 4);
assert.ok(radiusOf({ degree: 999 }) <= MAX_RADIUS, "the size scale is clamped");
assert.ok(radiusOf({ degree: 40 }) <= MAX_RADIUS);
assert.ok(radiusOf({ type: "project", degree: 0 }) > radiusOf({ type: "note", degree: 0 }), "a structural type is bigger before it has any edges");
assert.ok(Number.isInteger(MAX_RADIUS) && MAX_RADIUS > 4);

// --- semantic signals, checked against the shapes in the author's real workspace
//
// Four objects are titled "...feedback...", have no link between them and sit
// under different parents. Grouping them is the entire point of this layer, and
// the hand-written stopword list in the design prototype suppressed exactly it.
const feedbackish = [
  object("f1", { title: "Feedback 18.08.26 #1", parent_id: "p1" }),
  object("f2", { title: "Graph feedback", parent_id: "p1" }),
  object("f3", { title: "Feedback 23.08.26", parent_id: "p2" }),
  object("f4", { title: "Habit tracker feedback", parent_id: "p2" }),
  object("k1", { title: "KAFKA issue", parent_id: "p3" }),
  object("k2", { title: "Kafka issue review", parent_id: "p3" }),
  object("x1", { title: "Trainlog", parent_id: "p3" }),
  // Filler with nothing in common, so document frequency sees a corpus the size
  // of a real workspace. In a 7-object fixture "feedback" is on 57% of titles
  // and the ceiling correctly zeroes it; on the author's 67 objects it is on 6%.
  ...Array.from({ length: 24 }, (_, index) => object(`z${index}`, { title: `unrelated ${index}`, parent_id: "p4" })),
];
const semantic = buildGraph(feedbackish, []);
const derived = semanticEdges(semantic.nodes);
const pairs = new Set(derived.map((edge) => [edge.from, edge.to].sort().join("|")));
assert.ok(pairs.has("f1|f2"), "'feedback' must survive: it is a real grouping word here");
assert.ok(pairs.has("k1|k2"), "shared 'kafka' across two types and no stored link");
assert.ok(![...pairs].some((pair) => pair.includes("x1")), "a title sharing nothing must stay unconnected");
for (const edge of derived) {
  assert.ok(edge.reasons.length > 0, "every derived edge must be able to say why");
  assert.ok(edge.score > 0 && Number.isFinite(edge.score));
}

// Document frequency, not a word list: a term on more than a quarter of the
// objects is the workspace's vocabulary and carries no information about a pair.
const everywhere = Array.from({ length: 8 }, (_, index) => object(`e${index}`, { title: `notible item ${index}` }));
const weights = documentFrequency(everywhere.map((entry) => keywordsOf(entry.title)));
assert.equal(weights.get("notible"), 0, "a term on every object is worth nothing");
assert.equal(weights.get("item"), 0);
assert.ok(semanticEdges(buildGraph(everywhere, []).nodes).length === 0, "and produces no edges at all");

// Inference must never outrank a stored fact, and must never restate one.
const tagged = [
  object("t1", { title: "alpha", props: JSON.stringify({ tags: ["ui", "ux", "bug", "editor"] }) }),
  object("t2", { title: "beta", props: JSON.stringify({ tags: ["ui", "ux", "bug", "editor"] }) }),
  // Untagged filler, again so the tags read as rare rather than universal.
  ...Array.from({ length: 24 }, (_, index) => object(`u${index}`, { title: `unrelated ${index}` })),
];
const tagEdges = semanticEdges(buildGraph(tagged, []).nodes);
assert.equal(tagEdges.length, 1, "two objects sharing four rare tags are one edge");
assert.ok(tagEdges[0].score <= 7, "four shared tags must not beat an explicit relation");
assert.equal(semanticEdges(buildGraph(tagged, []).nodes, new Set(["t1|t2"])).length, 0, "a stored pair is not re-derived");

// props is untrusted: it arrives by sync, import and any plugin's objects.create.
assert.deepEqual(tagsOf({ props: "not json" }), []);
assert.deepEqual(tagsOf({ props: JSON.stringify({ tags: "ui" }) }), []);
assert.deepEqual(tagsOf({ props: JSON.stringify({ tags: [1, " UI ", "ui", ""] }) }), ["ui"]);
assert.deepEqual(tagsOf({}), []);

// top-k keeps one over-connected object from wiring the whole graph.
const hub = Array.from({ length: 30 }, (_, index) => object(`h${index}`, { title: `report ${index} shared shared` }));
for (const edge of semanticEdges(buildGraph(hub, []).nodes, new Set(), { topK: 3 })) {
  assert.ok(edge.score > 0);
}
const counts = new Map();
for (const edge of semanticEdges(buildGraph(hub, []).nodes, new Set(), { topK: 3 })) {
  counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
  counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
}
assert.ok(Math.max(...counts.values()) <= 3, "top-k is per object");

// --- dots
//
// 0.11.0: nodes are circles, not cards. Two dots overlap when the distance
// between their centres is under the sum of their radii. `layout` places `r`
// on every node, so the check reads it rather than a constant.
const countOverlaps = (dots) => {
  let overlaps = 0;
  for (let i = 0; i < dots.length; i += 1) {
    for (let j = i + 1; j < dots.length; j += 1) {
      const minDist = (dots[i].r ?? radiusOf(dots[i])) + (dots[j].r ?? radiusOf(dots[j]));
      if (Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y) < minDist) overlaps += 1;
    }
  }
  return overlaps;
};
// 67 is the real workspace this was built against, 100/200/400 margins above
// it. The separation pass is a fixed number of O(n^2) sweeps — dots with a
// 12-unit hard gap resolve far more easily than the old cards, so this holds
// comfortably across the live-physics range.
for (const count of [40, 67, 100, 200, 400]) {
  const crowd = buildGraph(Array.from({ length: count }, (_, index) => object(`c${index}`, { title: `note ${index}` })), []);
  assert.equal(countOverlaps(layout(crowd)), 0, `no two dots may overlap at ${count} objects`);
}
assert.ok(layout(buildGraph([object("a"), object("b")], []))[0].r >= 4, "every laid-out node carries a radius");
assert.ok(canvasFor(67).width > canvasFor(5).width, "the canvas has to grow with the workspace");

// An edge leaves a dot on its circumference: drawn centre to centre it would
// vanish under the dot, drawn from nowhere it would float short of it.
assert.deepEqual(nodeExit({ x: 0, y: 0 }, { x: 10, y: 0 }, 5), { x: 5, y: 0 }, "a horizontal edge leaves at radius on the x axis");
assert.deepEqual(nodeExit({ x: 0, y: 0 }, { x: 0, y: 10 }, 5), { x: 0, y: 5 }, "and a vertical one on the y axis");
assert.deepEqual(nodeExit({ x: 5, y: 5 }, { x: 5, y: 5 }, 6), { x: 5, y: 5 }, "two dots in the same place must not divide by zero");
for (const point of [nodeExit({ x: 0, y: 0 }, { x: 3, y: -7 }, 6), nodeExit({ x: 0, y: 0 }, { x: -3, y: 7 }, 6)]) {
  assert.ok(Math.abs(Math.hypot(point.x, point.y) - 6) < 0.001, "the exit point sits exactly on the circle");
}

// Every reason has to render as words, or the edge cannot be challenged.
for (const kind of ["tag", "keyword", "parent"]) {
  assert.ok(reasonText({ kind, value: "x" }).length > 0);
}

// --- the node cap
const many = Array.from({ length: 1600 }, (_, index) => object(`n${index}`));
const capped = buildGraph(many, []);
assert.equal(capped.nodes.length, 1500);
assert.equal(capped.truncated, true, "and the UI is told, rather than quietly showing a partial workspace");
assert.equal(capped.total, 1600);

// --- no markup is ever built from a string
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
  assert.ok(!source.includes(banned), `${banned} must not appear: note titles are untrusted text`);
}
// --- controls
//
// The filter must not move anything: a slider that reshuffles the map makes it
// impossible to see what the slider did.
assert.ok(source.includes("canvas.applyFilter"), "the controls filter edges");
assert.ok(!/applyFilter[\s\S]{0,400}layout\(/.test(source), "filtering must not recompute the layout");
// No 'type: "range"': the "suggested strength" slider was removed — it hid
// facts by score and read as clutter. The layer checkboxes remain the only
// filter, and they only show/hide, never reshuffle.
assert.ok(!source.includes('type: "range"'), "the suggested-strength slider must stay removed");
for (const control of ['type: "checkbox"', "data-lens"]) {
  assert.ok(source.includes(control), `the graph must ship ${control}`);
}
assert.ok(!source.includes("innerText"), "node text goes in through textContent only");

// 0.11.0 — dots, not cards.
assert.ok(source.includes('svg("circle", { class: "ngraph-dot"'), "the node is a circle now");
assert.ok(!/class:\s*"ngraph-card"/.test(source) && !source.includes("ngraph-card-body"), "the rectangular card and its foreignObject body are gone");
assert.ok(!source.includes("foreignObject"), "no foreignObject: a dot's label is plain SVG <text>, one line");
assert.ok(source.includes('svg("text", { class: "ngraph-label"'), "and the label is an SVG text element");
// A transparent hit disc under the visible dot: a hollow "filed under nothing"
// ring otherwise only catches hover on its 1.5px stroke. The visible dot takes
// no pointer events so everything lands the same way.
assert.ok(source.includes('svg("circle", { class: "ngraph-hit"') && /\.ngraph-hit \{ fill: transparent/.test(source), "the node has a transparent full-area hit target");
assert.ok(/\.ngraph-dot \{[^}]*pointer-events: none/.test(source), "and the visible dot itself takes no pointer events");
// The label is drawn for every node but shown only for the structural ones or
// the one under the pointer — otherwise the canvas is a wall of text.
assert.ok(source.includes("LABEL_DEGREE_MIN") && source.includes('dataset.label = alwaysLabel'), "label visibility is a threshold, not always-on");
assert.ok(/\.ngraph-node\[data-label="always"\] \.ngraph-label \{[^}]*opacity: 1/.test(source), "a structural node keeps its label without a hover");
assert.ok(/\.ngraph-node:hover \.ngraph-label[\s\S]{0,80}opacity: 1/.test(source), "and any node shows its label on hover");
// The legend type chips are filters, not just a key. Like every other control
// here they only show/hide — never move a node or nudge the simulation.
assert.ok(source.includes("canvas.applyTypeFilter") && source.includes("canvas.hiddenTypes"), "types can be filtered from the legend");
assert.ok(!/applyTypeFilter[\s\S]{0,400}(layout\(|simulationStep|wake\()/.test(source), "hiding a type must not reshuffle the map");
assert.ok(/element\("button", \{ type: "button", className: "ngraph-key ngraph-key--type"/.test(source), "the type chip is a real <button>, so the keyboard and screen reader work");
assert.ok(/chip\.addEventListener\("click"[\s\S]{0,500}hiddenTypes/.test(source), "and it is wired to the type filter");

// The two views this plugin exists for. Both are pure show/hide over the same
// layout — a data attribute on the canvas and a CSS rule, never a relayout.
assert.ok(source.includes('line.dataset.crossing = "yes"') && /rootIdOf\(edge\.from, byId\) !== rootIdOf\(edge\.to, byId\)/.test(source), "a link that leaves its container is marked at draw time");
assert.ok(source.includes('canvas.dataset.crossingOnly') && source.includes('canvas.dataset.unfiledOnly'), "the toolbar has a 'crossing only' and an 'unfiled only' view");
assert.ok(/\.ngraph-canvas\[data-crossing-only="yes"\] \.ngraph-edge:not\(\[data-crossing="yes"\]\) \{ display: none/.test(source), "crossing-only hides every non-crossing edge, in CSS");
assert.ok(/\.ngraph-canvas\[data-unfiled-only="yes"\] \.ngraph-node:not\(\[data-free="yes"\]\) \{ display: none/.test(source), "unfiled-only hides every filed node, in CSS");
assert.ok(!/crossingOnly[\s\S]{0,300}(layout\(|simulationStep|wake\()/.test(source) && !/unfiledOnly[\s\S]{0,300}(layout\(|simulationStep|wake\()/.test(source), "neither view reshuffles the map");
// 0.11.4 — matched to Core's own chip standard (the 0.83.6 search-filter
// redesign): the Fit button and the toggles are now both flat pills, not
// the plugin's earlier outlined-rectangle look.
assert.ok(/\.ngraph-fit \{[^}]*border-radius: 999px[^}]*background: var\(--notible-accent\)/.test(source), "Fit to window is a filled accent pill");
assert.ok(/\.ngraph-toggle \{[^}]*border-radius: 999px[^}]*background: var\(--notible-hover\)/.test(source), "the toggles are flat pills, matching Core's search-chip standard");
// Totals opens as an absolute popover so it cannot push the toolbar wider or
// the canvas down — the bug on the first pass.
assert.ok(/\.ngraph-stats \{[\s\S]*?position: absolute/.test(source), "the Totals body is a popover, not an inline block that reflows the row");

// The three signals measured as noise in the real data must stay out.
for (const dead of ["sameStatus", "dateProximity", "closeDate"]) {
  assert.ok(!source.includes(dead), `${dead} was measured as noise and must not come back`);
}
// --- the surfaces
//
// The home is a registered view. CoreOnlyApp reads registered views off the
// extension-host snapshot and gives each one a nav entry beside Notes; `mount`
// is what draws into the pane, and a registration without one gets the nav
// entry and a pane that says the view registered no mount. So the mount is the
// assertion, not the registration.
assert.ok(source.includes("context.views.register({"), "the graph's home is a registered view, not a modal");
assert.ok(/context\.views\.register\(\{[\s\S]{0,240}mount:/.test(source), "a view without a mount renders nothing at all");
assert.ok(/context\.views\.register\(\{[\s\S]{0,240}id: "surface"/.test(source), "the view id is slug-like and stable: it lands in the section string and a data attribute");
assert.ok(/context\.views\.register\(\{[\s\S]{0,240}title: "Graph"/.test(source), "the title is the nav label verbatim, so it stays short enough for the rail");
// One surface, two homes. Two copies of it drift, and the half that drifts is
// always the one nobody opened while working on the other.
assert.equal((source.match(/mountSurface\(context, host/g) ?? []).length, 2, "the view and the modal mount the same implementation");
// 0.8.0 dropped the bottom-sidebar open-Graph button: it only duplicated the
// nav card views.register already gives the plugin, one click away either way.
assert.ok(!source.includes('registerSlot("workspace.sidebar"'), "the duplicate sidebar button must stay removed");
assert.ok(source.includes('navIcon: "network"'), "the nav card must carry its own icon, not the shared puzzle piece");
// Every entry point goes to the VIEW now, through one helper. The modal is the
// fallback for a host that renders no views, which is the only thing
// `openView` answers false to. What replaced the old "there is no such call"
// assertion is the shape of the call and of the fallback: both are source-only
// facts, since neither a shell nor a host exists under plain node.
assert.ok(source.includes('context.ui.openView("surface")'), "the button and the command open the registered view, and by the id registered above");
assert.ok(/openView\("surface"\)[\s\S]{0,200}if \(!shown\) openGraphModal\(context\)/.test(source), "false means this host cannot render views at all — that, and only that, is what the modal is for");
assert.ok(source.includes("function openGraphModal(context)"), "so the modal has to still exist");
// One helper, two callers. A fallback written twice rots in the copy nobody
// exercised, and this one is exercised on no developer's machine.
assert.equal((source.match(/showGraph\(context\)/g) ?? []).length, 2, "the command shares one way in with its declaration, now that the duplicate sidebar button is gone");
assert.ok(!/openGraphModal\(context\)/.test(source.slice(source.indexOf("onload(context)"))), "and nothing opens the modal directly any more");
// A rejection inside a synchronous click handler is invisible. openView
// rejects for a view id this plugin never registered — a bug, not an
// environment — so it must be said out loud rather than fall back to a modal
// that would look like everything working.
assert.ok(/\.catch\(\(cause\) => \{[\s\S]{0,200}ui\.notice\(/.test(source), "a rejected openView must surface, not vanish into the console");
// The pane draws its own border, background and radius. A root that draws them
// again is a card inside a card.
assert.ok(/\.ngraph--pane \{[^}]*flex: 1/.test(source), "the pane root stretches rather than sizing itself");
assert.ok(!/\.ngraph--pane[^{]*\{[^}]*(background|border-radius|border:)/.test(source), "and paints nothing: Core's pane already drew the card");
// The modal envelope arithmetic may live only on the modal. It is what made
// the graph read as a small floating box, and it must not follow the surface
// into a pane, where the height of Core's chrome is nobody's business here.
for (const [rule, why] of [["100vw - 96px", "the modal width"], ["88vh - 250px", "the modal canvas height"]]) {
  assert.ok(source.includes(rule), `${why} is still needed by the modal`);
  const scoped = new RegExp(`\\.ngraph--modal [^{]*\\{[^}]*${rule.replace(/[-]/g, "\\$&")}`);
  assert.ok(scoped.test(source), `${why} must be scoped to .ngraph--modal, never applied in the pane`);
}
// An awaited read can finish after the modal is closed; drawing into a
// detached container is invisible at best and draws the graph twice at worst.
assert.ok(source.includes("if (disposed) return;"), "the async read must stop after dispose");

// A graph you cannot move is a picture. Live test 23.08 found exactly that:
// no pan, no zoom, nothing the scroll wheel did.
for (const handler of ["pointerdown", "wheel", "fitView"]) {
  assert.ok(source.includes(handler), `the canvas must handle ${handler}`);
}

// --- colour by type
//
// The same type must always answer with the same hue, on this machine and on
// every other one, or the picture changes for no reason the user can see.
const REAL_TYPES = ["task", "issue", "note", "project", "milestone", "space", "folder", "habit", "cycle"];
for (const type of [...REAL_TYPES, "", "0", "a type nobody has invented yet"]) {
  const hue = hueOfType(type);
  assert.equal(hueOfType(type), hue, `hueOfType(${type}) must not change between calls (no hidden state)`);
  assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `hueOfType(${type}) must be a hue in [0, 360)`);
}
assert.equal(hueOfType(undefined), hueOfType(undefined), "a missing type still answers, and answers the same thing");

// The hue a card actually gets is resolved against the types PRESENT, so two
// types on one canvas never share a stripe while a slot is free. That has to
// depend on the set of types, never on the order the objects arrived in.
const resolved = typeHues(REAL_TYPES);
assert.equal(resolved.size, REAL_TYPES.length, "every type present gets a hue");
assert.equal(new Set(resolved.values()).size, REAL_TYPES.length, "and no two of the real type vocabulary share one");
for (const hue of resolved.values()) assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360);
assert.deepEqual([...typeHues([...REAL_TYPES].reverse())], [...resolved], "the answer depends on the SET of types, not the order they arrive in");
assert.deepEqual([...typeHues([...REAL_TYPES, "note", "task"])], [...resolved], "and repeats change nothing");
// Neighbouring hues must not be confusable at the size of a 4px stripe. The
// palette is separated by construction; this is the assertion that keeps a
// future edit to it honest.
const spread = [...resolved.values()].sort((left, right) => left - right);
for (let i = 1; i < spread.length; i += 1) {
  assert.ok(spread[i] - spread[i - 1] >= 15, `hues ${spread[i - 1]} and ${spread[i]} are too close to tell apart on a stripe`);
}
assert.deepEqual([...typeHues([])], [], "an empty graph resolves no hues rather than throwing");
assert.deepEqual([...typeHues(null)], [], "and untrusted input degrades rather than throwing");

// hueOf survives as the cheap generic string hash. It no longer colours
// anything, but it is still exported and still has to be deterministic.
assert.equal(hueOf("proj-1"), hueOf("proj-1"), "the same string always hashes to the same hue");
for (const id of ["a", "proj-1", "0", "a very long container id indeed"]) {
  const hue = hueOf(id);
  assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `hueOf(${id}) must be a hue in [0, 360)`);
}

// rootIdOf still backs crossingLinks and the card's hover label. It no longer
// decides colour, so this is the check that it did not get broken on the way
// past.
const chainById = new Map([
  ["root", { id: "root", parentId: null }],
  ["mid", { id: "mid", parentId: "root" }],
  ["leaf", { id: "leaf", parentId: "mid" }],
]);
assert.equal(rootIdOf("leaf", chainById), "root");
assert.equal(rootIdOf("root", chainById), "root", "a free node is its own root");
assert.equal(rootIdOf("ghost", chainById), null, "an id the graph never loaded has no root");

// The colour is a TYPE colour now. Nothing in the source may still be reading
// a container to decide it, or the bug this replaced comes back the moment
// someone copies an old line.
for (const stale of ["--project-hue", "PROJECT_LEGEND_CAP", "ngraph-key--project", "canvas.projects"]) {
  assert.ok(!source.includes(stale), `${stale} belongs to the old per-container colour and must be gone`);
}
assert.ok(source.includes("--type-hue"), "the hue rides on a custom property, so the stylesheet keeps no colour literal");
// A dot is small enough to BE its colour — the card version painted only a
// thin stripe. The hue still comes from --type-hue, never a literal.
assert.ok(/\.ngraph-dot \{[^}]*fill: hsl\(var\(--type-hue\)/.test(source), "the dot is filled with its type's hue");
assert.ok(!source.includes("ngraph-card-accent"), "the old stripe element is gone");
// Colour is never the only carrier: the type is named in the accessible hover
// title, and a free dot is a hollow ring regardless of hue.
assert.ok(/hover\.textContent[\s\S]{0,300}\$\{node\.type\}/.test(source), "the type is spelled out in the hover title");
assert.ok(/\.ngraph-node\[data-free="yes"\] \.ngraph-dot \{[^}]*fill: none/.test(source), "a free dot reads as unfiled without relying on the hue");

// --- graph exclusion (props.$.graphExclude)
//
// A generic opt-out any object can carry, not a hardcoded type === "habit"
// check — props is untrusted input from sync, import and any plugin's
// objects.create, so this has to degrade to "not excluded" rather than throw.
assert.equal(isGraphExcluded({ props: JSON.stringify({ $: { graphExclude: true } }) }), true);
assert.equal(isGraphExcluded({ props: JSON.stringify({}) }), false, "no $ namespace at all excludes nothing");
assert.equal(isGraphExcluded({ props: JSON.stringify({ $: { graphExclude: false } }) }), false);
assert.equal(isGraphExcluded({ props: JSON.stringify({ $: "not an object" }) }), false, "a $ that is not an object must not throw or match");
assert.equal(isGraphExcluded({ props: JSON.stringify({ $: ["array"] }) }), false, "an array is not the $ namespace either");
assert.equal(isGraphExcluded({ props: "not json" }), false, "broken props degrade to not-excluded");
assert.equal(isGraphExcluded({}), false);
assert.equal(
  buildGraph([object("a"), object("b", { props: JSON.stringify({ $: { graphExclude: true } }) })], []).nodes.length,
  1,
  "an excluded object never becomes a node",
);

// --- the live simulation
//
// The starting picture stays deterministic. This is the assertion the whole
// physics change had to survive: same workspace, same shape, every open.
const settled = layout(graph);
const settledAgain = layout(graph);
assert.deepEqual(
  settled.map((node) => [node.id, node.x, node.y]),
  settledAgain.map((node) => [node.id, node.x, node.y]),
  "the initial layout is the same on two calls — the live loop starts from it, it does not replace it",
);

// One tick has to move the graph a real, finite amount and report how much.
const ticking = layout(graph).map((node) => ({ ...node }));
const energy = simulationStep(ticking, graph.edges, { centre: { x: 400, y: 300 } });
assert.ok(Number.isFinite(energy) && energy >= 0, "a tick reports a finite, non-negative energy");
for (const node of ticking) {
  assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.id} must still be at a real coordinate after a tick`);
}
assert.equal(simulationStep([], [], {}), 0, "an empty graph ticks to nothing rather than dividing by zero");

// A held or parked card does not move, whatever the rest of the graph does to
// it. That is what makes dragging feel like putting something down.
const pinned = layout(graph).map((node) => ({ ...node }));
pinned[0].fixed = true;
const where = { x: pinned[0].x, y: pinned[0].y };
for (let step = 0; step < 30; step += 1) simulationStep(pinned, graph.edges, {});
assert.deepEqual({ x: pinned[0].x, y: pinned[0].y }, where, "a fixed card is never integrated");

// Damping, not cooling: the graph has to come to rest on its own, or the loop
// that watches for rest never stops and neither does the fan.
const settling = layout(graph).map((node) => ({ ...node }));
let last = Infinity;
for (let step = 0; step < 400; step += 1) last = simulationStep(settling, graph.edges, {});
assert.ok(last < 0.05, `the simulation must settle, ended at ${last}`);

assert.ok(Number.isInteger(LIVE_PHYSICS_MAX_NODES) && LIVE_PHYSICS_MAX_NODES > 0);
assert.ok(LIVE_PHYSICS_MAX_NODES < 1500, "live physics must switch off below the node cap: O(n^2) at 1500 is 62ms a tick");

// The gesture. A press that never travels is a click and opens the note; past
// the threshold it is a drag. Both live in drawGraph, which needs a DOM this
// check does not have, so they are asserted against the source.
assert.ok(source.includes("DRAG_THRESHOLD"), "a click must be told from a drag by a movement threshold, not by luck");
assert.ok(source.includes("suppressClick"), "the click that ends a drag must be swallowed");
assert.ok(/keydown[\s\S]{0,160}"Enter"/.test(source), "Enter and Space still open a focused card");
assert.ok(source.includes("requestAnimationFrame"), "the live loop is a rAF loop");
assert.ok(source.includes("cancelAnimationFrame"), "and dispose has to stop it, or it runs forever against a detached SVG");

// --- what dispose tears down
//
// The most expensive way to get this wrong, and the one least likely to be
// noticed in review: Core disposes the view on navigate-away, disable, reload
// and uninstall, and clears the container. Everything the surface holds
// OUTSIDE that container survives it — the animation frame, the resize
// observer, and the three window listeners a drag in flight owns — and an
// O(n^2) tick against a detached SVG burns a core for as long as the app is
// open with nothing on screen to show for it. Asserted against the source,
// because all of it needs a DOM this check does not have.
assert.ok(source.includes("canvas.teardown"), "the surface ends everything it owns in one call, so no caller has to remember three");
const teardown = source.match(/canvas\.teardown = \(\) => \{[\s\S]{0,600}?\n  \};/);
assert.ok(teardown, "teardown must be findable: the assertions below read its body, not the whole file");
assert.ok(teardown[0].includes("cancelAnimationFrame"), "teardown cancels the animation frame — the leak that costs a core");
assert.ok(teardown[0].includes("stopPanZoom"), "and disconnects the resize observer, which the browser holds, not the removed subtree");
assert.ok(teardown[0].includes("releaseGestures"), "and ends a drag still in flight, whose listeners are on window");
assert.ok(/releaseGestures[\s\S]{0,200}cancelAnimationFrame/.test(teardown[0]), "releases run BEFORE the cancel: a release wakes the loop, and waking a cancelled loop is the leak coming back in");
assert.ok(source.includes("if (stopped || !live"), "and a woken loop after teardown must refuse to start rather than merely be cancelled again");
assert.ok(/dispose: \(\) => \{[^}]*teardown\?\.\(\)/.test(source), "the Disposable Core actually calls is what runs it");
assert.ok(source.includes('window.removeEventListener("pointermove"'), "the drag's window listeners come off, not just the card's");

// The canvas has no size of its own in a pane: it is whatever the flex column
// leaves it, and that changes with the window. Both places that read the
// element's size must be reading it as it is now, not as it was at mount.
assert.ok(source.includes("ResizeObserver"), "a resize has to reach the viewBox, or the graph is framed for a window that is gone");
assert.ok(/perPixel = \(\) => \{[\s\S]{0,200}getBoundingClientRect\(\)/.test(source), "one client pixel is measured per gesture, never cached at mount");
assert.ok(source.includes("prefers-reduced-motion"), "reduced motion must skip the animation entirely");
// The controls still may not move anything: a control that reshuffles the map
// makes it impossible to see what the control did.
assert.ok(!/applyFilter[\s\S]{0,400}(simulationStep|wake\()/.test(source), "filtering must not nudge the simulation either");

console.log("Notible Graph self-check passed.");
