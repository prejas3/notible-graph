/**
 * Notible Graph — ALPHA.
 *
 * A map of the workspace. The visual design is still settling; 0.11.0 replaced
 * the rectangular title cards with dots, because on a real workspace the cards
 * overlapped into a cloud of labels and buried the edges.
 *
 * A node is a small circle, its radius growing with how connected it is, and a
 * structural type (project, milestone, chapter…) starting larger. Its title is
 * drawn beside it but shown only for the nodes that carry the structure of the
 * graph, or for whatever the pointer is over — the rest stay bare dots so the
 * canvas reads as a network, not a wall of text.
 *
 * What it is NOT: Obsidian's graph. There, the graph is the only structure,
 * because there is no hierarchy. Here workspaces, projects and folders already
 * carry most of the meaning, so the layout keeps them: containment edges pull
 * a container's notes into a clump, [[wikilinks]] are the lines that cross
 * between clumps, and suggested edges (shared tags and title words) are a
 * third, weaker layer that always says why. The payoff is the two things the
 * sidebar tree cannot show: links that cross project boundaries, and notes
 * that hang under nothing.
 *
 * Every dot is coloured by its own TYPE, not by the container it sits in: in
 * the ordinary shape of a workspace everything lives under one project, and a
 * colour that is the same everywhere carries nothing.
 *
 * The picture the graph OPENS on is deterministic — `layout` below is a pure,
 * fixed-iteration spring model seeded from the note ids. A rAF loop then
 * continues from it so dots can be dragged and the rest of the graph reacts,
 * and parks itself once the graph is still again. The deterministic part is
 * never replaced; the live part only ever starts from it.
 *
 * Its home is a registered view — a full-width pane next to Notes, not a
 * floating box. A map of a workspace wants the whole screen; the modal it used
 * to open in was never the right envelope for one, and every piece of sizing
 * arithmetic written to fit that envelope has gone with it. The sidebar button
 * and the command go to that pane as well, through `ui.openView` (API 1.8).
 * The modal is no longer where anything opens: it is the fallback for a host
 * with nowhere to render a view at all, which is the one case `openView`
 * answers `false` to — see `showGraph`.
 *
 * One ES module, no build step, no dependencies, no network. The pure
 * functions are exported by name so `self-check.mjs` can run them under plain
 * node; the plugin itself is the default export.
 */

/** Above this the picture is a hairball whatever the layout does, and the
 * O(n^2) repulsion below stops being free. Alpha: a flat cap and an honest
 * message rather than clustering nobody has designed yet.
 * ponytail: raise it when a real workspace hits it, not before. */
const MAX_NODES = 1500;

/**
 * Above this many cards the live simulation is switched off and the graph is
 * drawn from the settled one-shot `layout` instead.
 *
 * Measured, not guessed. One tick is the same O(n^2) repulsion `layout` runs,
 * timed under node 22 — the same V8 the app's webview runs — on this machine:
 *
 *   100 cards  1.1 ms    400 cards  4.7 ms    1000 cards  27 ms
 *   200 cards  1.2 ms    500 cards  7.4 ms    1500 cards  62 ms
 *
 * A frame is 16.7 ms and the DOM writes for n cards and their edges have to
 * fit in it too. 400 is the last size that leaves most of the frame for them.
 * Past it the honest thing is to say so in the UI, not to ship a graph that
 * drops the whole app to a few frames a second the moment it opens.
 */
export const LIVE_PHYSICS_MAX_NODES = 400;

/**
 * 0.11.0 — dots, not cards.
 *
 * The node used to be a 152x56 rectangle carrying its title. On a real
 * workspace that turned the graph into a cloud of overlapping labels with the
 * edges buried under them. A node is now a small circle whose radius grows
 * with how connected it is, its title drawn beside it and shown only when the
 * node matters (high degree, or a structural type) or on hover. This is what
 * every graph view does, and for the same reason.
 */

/** Structural object types draw larger and always keep their label: they are
 * the landmarks someone reads the graph BY. Everything else is a plain dot
 * until it earns a label through its degree.
 * ponytail: a hardcoded set, not a per-type weight config nobody would tune. */
const STRUCTURAL_TYPES = new Set([
  "project", "milestone", "space", "folder", "cycle", "release",
  "notible.typewriter.manuscript", "notible.typewriter.act", "notible.typewriter.chapter",
]);

/** A node whose degree reaches this keeps its label without a hover. Below it
 * the label is drawn but hidden until the pointer or the lens reaches the node. */
const LABEL_DEGREE_MIN = 3;

/** The biggest a dot's radius can get, in user units. `radiusOf` clamps to it;
 * the layout and the viewBox margin both read it so a hub never clips. */
export const MAX_RADIUS = 17;

/**
 * Clear space a dot demands around itself, centre-to-centre, ON TOP OF the two
 * radii, in the repulsion of both the one-shot layout and the live simulation.
 *
 * A fraction of what the card version reserved (64/48) — a dot needs room to
 * read as separate, not room for a paragraph. Small enough that a connected
 * pair still sits close enough to read as connected.
 */
const GAP = 30;
/** The spring and repulsion constants, shared by the one-shot layout and the
 * live simulation so the two can never disagree about the shape of the graph. */
// Springs are deliberately weak: a link should read as a gentle rubber-band
// that keeps two notes near each other, not a winch that reels the whole
// graph into a knot. Repulsion spreads the resting graph so the edges have
// room to be seen. Retuned for dots and measured on a dense random fixture
// (scratchpad, per the "verify physics empirically" rule): the card version's
// 8800 assumed a node 150 units wide and at dot scale flung everything to the
// canvas edges. 1600 with the live loop's damping settles a 40-node graph in
// ~250 frames and a 150-node one in ~550, overlap-free at every size.
const PULL = { parent: 0.008, link: 0.0035, semantic: 0.0014 };
const REPULSION = 1600;
/** The uncooled separation pass's margin: just under GAP, a hard non-overlap
 * floor rather than the aesthetic gap the springs aim for. */
const HARD_GAP = 12;

/** Fixed iterations. This is the DETERMINISTIC part: the same workspace must
 * open on the same picture, and a fixed-iteration pure function is the one a
 * self-check can assert on. The live simulation continues from where this
 * leaves off; it never replaces it. */
const ITERATIONS = 260;

// ------------------------------------------------------------- the graph

/** Titles collide, so wikilink resolution has to pick one target and be
 * consistent about it. Lowercased and trimmed, first object wins by id order
 * — arbitrary, but stable between two runs and between two machines. */
function titleIndex(objects) {
  const index = new Map();
  for (const object of [...objects].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const key = String(object.title ?? "").trim().toLowerCase();
    if (key && !index.has(key)) index.set(key, object.id);
  }
  return index;
}

/**
 * Turn objects plus the content index's `link` entries into nodes and edges.
 *
 * Everything here is untrusted: titles and link targets come from import, from
 * sync, and from any plugin's `objects.create`. A link to a note that does not
 * exist, to itself, or to a title that is only whitespace is dropped rather
 * than drawn as an edge to nowhere.
 */
export function buildGraph(objects, linkEntries = []) {
  const list = Array.isArray(objects) ? objects.filter((object) => object && object.id && !isGraphExcluded(object)) : [];
  const truncated = list.length > MAX_NODES;
  const kept = list.slice(0, MAX_NODES);
  const byId = new Map(kept.map((object) => [object.id, object]));
  const index = titleIndex(kept);

  const nodes = kept.map((object) => {
    const parentId = object.parent_id && byId.has(object.parent_id) ? object.parent_id : null;
    const title = String(object.title ?? "").trim() || "Untitled";
    return {
      id: object.id,
      title,
      type: String(object.type ?? "note"),
      tags: tagsOf(object),
      keywords: keywordsOf(title),
      parentId,
      // "Free" means: sits under no container the graph can see. That is the
      // whole reason someone opens this thing, so it is a first-class flag
      // rather than something the eye has to find.
      free: parentId === null,
      degree: 0,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const edges = [];
  const seen = new Set();
  for (const node of nodes) {
    if (node.parentId) edges.push({ from: node.parentId, to: node.id, kind: "parent" });
  }
  for (const entry of Array.isArray(linkEntries) ? linkEntries : []) {
    if (!entry || entry.kind !== "link") continue;
    const from = nodeById.get(entry.object_id);
    const target = String(entry.value ?? "").trim().toLowerCase();
    if (!from || !target) continue;
    const toId = index.get(target);
    if (!toId || toId === from.id) continue;
    // One line per pair, whichever way round and however many times the note
    // repeats the link. A note that mentions another twelve times is not
    // twelve times more connected, it is just noisier to draw.
    const key = from.id < toId ? `${from.id}|${toId}` : `${toId}|${from.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: from.id, to: toId, kind: "link" });
    from.degree += 1;
    nodeById.get(toId).degree += 1;
  }

  return { nodes, edges, truncated, total: list.length };
}

// ------------------------------------------------------- semantic signals
//
// The second layer: edges nobody stored, derived from what the objects have in
// common. Two rules hold the whole thing together.
//
//   1. A derived edge NEVER outweighs a stored one. Similarity is a hypothesis
//      about two objects; a [[link]] is a fact about them.
//   2. Every derived edge carries `reasons`, so the UI can answer "why are
//      these two next to each other" without the user trusting a number.
//
// Two signals only: shared title words and shared tags. Same-type, same-status
// and near-in-time were all measured against a real workspace and dropped —
// "open" and "task" are true of half the objects, and timestamps cluster around
// bulk edits, so all three produce confident-looking edges that mean nothing.

/** Words in a title worth comparing. Deliberately no stopword list: a hand-written
 * one is tuned to the workspace that was in front of whoever wrote it, and the
 * one this replaced silently suppressed "feedback" — the single most useful
 * grouping word in the author's own data. Document frequency decides instead. */
export function keywordsOf(title) {
  const normalized = String(title ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "");
  return [...new Set(normalized.split(/[^a-z0-9]+/u).filter((word) => word.length > 2))];
}

/**
 * `props.$.graphExclude`, defensively: props is user/sync/plugin data and may
 * be anything. `$` is the reserved namespace inside `props` for cross-plugin
 * signalling — `props.$._projectCalendarEvents` is the existing example —
 * and `graphExclude` is a new, deliberately generic entry in it: "do not draw
 * me in the workspace graph", for any utility object no plugin should file
 * under nothing, not a hardcoded `type === "habit"` check here. Malformed
 * props, a `$` that is not an object, or the flag simply absent all degrade
 * to "not excluded" — the safe default is to draw the object, same as before
 * this existed.
 */
export function isGraphExcluded(object) {
  try {
    const props = JSON.parse(object?.props || "{}");
    const ns = props?.$;
    return !!(ns && typeof ns === "object" && !Array.isArray(ns) && ns.graphExclude === true);
  } catch {
    return false;
  }
}

/** props.tags, defensively: props is user/sync/plugin data and may be anything. */
export function tagsOf(object) {
  try {
    const props = JSON.parse(object?.props || "{}");
    const tags = Array.isArray(props?.tags) ? props.tags : [];
    return [...new Set(tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim().toLowerCase()))];
  } catch {
    return [];
  }
}

/**
 * Inverse document frequency, with a hard ceiling.
 *
 * A term on more than a quarter of the objects tells you nothing about any pair
 * of them — it is the workspace's own vocabulary, not a connection. Those go to
 * zero outright rather than to a small number, because a small number times a
 * lot of pairs is still a hairball. This is what the removed stopword list was
 * badly approximating, except it is computed from the data and needs no tuning.
 */
export function documentFrequency(groups) {
  const counts = new Map();
  for (const group of groups) for (const term of new Set(group)) counts.set(term, (counts.get(term) ?? 0) + 1);
  const total = Math.max(1, groups.length);
  const weights = new Map();
  for (const [term, count] of counts) {
    weights.set(term, count / total > 0.25 ? 0 : Math.log(total / count));
  }
  return weights;
}

/** Never let inference outrank a stored relation. Anything derived is clamped
 * below this; stored edges are scored above it by the caller. */
const MAX_DERIVED_SCORE = 7;
/** Per object, not per graph: without it one heavily tagged object connects to
 * everything and the threshold slider becomes the only usable control. */
const DEFAULT_TOP_K = 8;

/**
 * Derived edges between nodes, strongest `topK` per node, deduplicated.
 *
 * `stored` is the set of pairs that already have a real edge; those are skipped
 * here so a fact is never drawn twice, once as itself and once as a weaker guess.
 */
export function semanticEdges(nodes, stored = new Set(), { topK = DEFAULT_TOP_K, threshold = 1 } = {}) {
  const keywordWeights = documentFrequency(nodes.map((node) => node.keywords));
  const tagWeights = documentFrequency(nodes.map((node) => node.tags));
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const scored = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (stored.has(pairKey(a.id, b.id))) continue;
      const reasons = [];
      let score = 0;

      const sharedTags = a.tags.filter((tag) => b.tags.includes(tag) && (tagWeights.get(tag) ?? 0) > 0);
      if (sharedTags.length) {
        // Capped at two: a pair sharing four tags is not twice the pair sharing
        // two, and uncapped it used to beat an explicit depends_on.
        const weight = sharedTags.slice(0, 2).reduce((sum, tag) => sum + tagWeights.get(tag), 0);
        score += weight * 1.6;
        reasons.push({ kind: "tag", value: sharedTags.join(", "), source: "derived" });
      }

      const sharedWords = a.keywords.filter((word) => b.keywords.includes(word) && (keywordWeights.get(word) ?? 0) > 0);
      if (sharedWords.length) {
        const weight = sharedWords.slice(0, 3).reduce((sum, word) => sum + keywordWeights.get(word), 0);
        score += weight * 1.4;
        reasons.push({ kind: "keyword", value: sharedWords.join(", "), source: "derived" });
      }

      if (!reasons.length) continue;
      // A shared container is context, not a reason on its own: it is recorded
      // so the inspector can say it, but it cannot lift a pair over the
      // threshold by itself.
      if (a.parentId && a.parentId === b.parentId) {
        score += 0.4;
        reasons.push({ kind: "parent", value: a.parentId, source: "stored" });
      }
      score = Math.min(MAX_DERIVED_SCORE, score);
      if (score >= threshold) scored.push({ from: a.id, to: b.id, kind: "semantic", score, reasons });
    }
  }

  scored.sort((left, right) => right.score - left.score || pairKey(left.from, left.to).localeCompare(pairKey(right.from, right.to)));
  const kept = [];
  const used = new Map();
  for (const edge of scored) {
    const fromCount = used.get(edge.from) ?? 0;
    const toCount = used.get(edge.to) ?? 0;
    if (fromCount >= topK || toCount >= topK) continue;
    used.set(edge.from, fromCount + 1);
    used.set(edge.to, toCount + 1);
    kept.push(edge);
  }
  return kept;
}

/**
 * Walk `id` up its `parentId` chain to the top-most container, or `id` itself
 * if it is free. This is what `crossingLinks` means by "the same place", and
 * it is also how a card names the container it sits in, in words, in its
 * hover label. It does NOT decide colour — see `typeHues` below.
 */
export function rootIdOf(id, byId) {
  const seen = new Set();
  let node = byId.get(id);
  while (node?.parentId && !seen.has(node.id)) {
    seen.add(node.id);
    node = byId.get(node.parentId);
  }
  // A parent cycle can arrive by import or by sync. It has no root, so both
  // ends would otherwise answer with a different node and a link INSIDE the
  // cycle would be reported as crossing between containers. Name the cycle
  // by its lowest id so every member of it answers the same thing.
  if (node?.parentId && seen.has(node.id)) return [...seen].sort()[0];
  return node?.id ?? null;
}

/** Links whose two ends live under different containers — the answer to "what
 * does the tree not show me". */
export function crossingLinks(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.filter((edge) => edge.kind === "link" && rootIdOf(edge.from, byId) !== rootIdOf(edge.to, byId));
}

/**
 * A stable hue (0–359) for any string. A plain string hash, not cryptographic:
 * it only has to answer the same thing twice, on this machine and on every
 * other one, which `charCodeAt` already gives us.
 *
 * Kept because it is the cheapest deterministic string->hue in the file, but
 * it is NOT what colours a card: see `hueOfType` and `typeHues`.
 */
export function hueOf(id) {
  let hash = 0;
  for (const character of String(id)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/**
 * Sixteen hues, hand-picked so that no two ADJACENT entries are confusable at
 * the size of a 4px stripe, and so the set stays legible against both themes'
 * surfaces (a light cream and a dark brown, per core-only.css).
 *
 * A fixed palette rather than `hueOf(type) % 360` because plain hashing does
 * not spread: hashing the real type vocabulary — task, issue, note, project,
 * milestone, space, folder, habit, cycle — straight onto the wheel put `note`
 * at 138 and `folder` at 126, twelve degrees apart, which at stripe size is
 * the same green. Picking from a separated palette makes the worst case a
 * clean repeat rather than a near-miss, and a repeat is the case the type name
 * printed on the card is there to settle.
 */
const TYPE_PALETTE = [6, 26, 42, 58, 86, 112, 132, 152, 172, 192, 210, 232, 252, 276, 300, 326];

/** Avalanche hash (FNV-1a plus a finalizer). The finalizer is the point: the
 * raw FNV of two short lowercase words differs in the low bits far too often,
 * and the low bits are exactly what `% TYPE_PALETTE.length` reads. */
function mixed(value) {
  let hash = 2166136261 >>> 0;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** The hue a type would like, before anybody else has claimed it. Deterministic
 * and in [0, 360) for any input, including "" and non-strings. */
export function hueOfType(type) {
  return TYPE_PALETTE[mixed(type) % TYPE_PALETTE.length];
}

/**
 * Resolve one hue per type actually present, so two types on the same canvas
 * never share a stripe while there is a free slot left.
 *
 * Types are sorted first and then take their preferred slot, linear-probing
 * forward when it is taken. Sorting is what makes it deterministic: the answer
 * depends on the SET of types in the workspace, never on the order the objects
 * came back from the database in. Past sixteen distinct types the palette is
 * full and the overflow falls back to its preferred hue, which means a repeat —
 * at which point the type spelled out on the card and in the legend is what
 * tells them apart, as it is for every other pair.
 */
export function typeHues(types) {
  const order = [...new Set((Array.isArray(types) ? types : []).map((type) => String(type ?? "")))].sort();
  const taken = new Set();
  const hues = new Map();
  for (const type of order) {
    let slot = mixed(type) % TYPE_PALETTE.length;
    for (let probe = 0; probe < TYPE_PALETTE.length && taken.has(slot); probe += 1) {
      slot = (slot + 1) % TYPE_PALETTE.length;
    }
    if (taken.has(slot)) { hues.set(type, hueOfType(type)); continue; }
    taken.add(slot);
    hues.set(type, TYPE_PALETTE[slot]);
  }
  return hues;
}

// ------------------------------------------------------------- the layout
//
// A plain spring/repulsion model, run to a fixed number of iterations and
// seeded from the node ids, so the same workspace draws the same picture every
// time. Random starting positions would move every dot on each open, which
// makes the graph unreadable as a thing you return to.
//
// This is the STARTING picture and nothing else. It is pure, it needs no DOM,
// and the self-check asserts it is identical across two calls. The live
// simulation further down continues from whatever this returns; it does not
// replace it and must not be folded into it.

function seededRandom(seed) {
  let state = 0;
  for (const character of String(seed)) state = (state * 31 + character.charCodeAt(0)) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Canvas big enough that dots have somewhere to spread into. The per-node
 * allowance is a small multiple of a dot's own size — dots do not need the
 * 150-unit-wide berth a card did, and giving them one just makes the graph
 * mostly empty space. */
export function canvasFor(count) {
  const side = Math.max(700, Math.sqrt(Math.max(1, count)) * 96);
  return { width: side, height: side * 0.7 };
}

export function layout(graph, { iterations = ITERATIONS, ...size } = {}) {
  const fitted = canvasFor(graph.nodes.length);
  const width = size.width ?? fitted.width;
  const height = size.height ?? fitted.height;
  const nodes = graph.nodes.map((node) => {
    const random = seededRandom(node.id);
    // `r` is carried on the node from here on: the collision code, the live
    // simulation and the edge-exit maths all need it, and `radiusOf` reading
    // `degree` means it is fixed for the life of the graph.
    return { ...node, r: radiusOf(node), x: random() * width, y: random() * height, vx: 0, vy: 0 };
  });
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Containment pulls harder than a link: a project's notes should read as a
  // clump, and a link between clumps should be visible as a line stretched
  // between them rather than as two clumps merged into one.
  // Shared with the live simulation, so the graph cannot settle into one shape
  // and then drift into a different one the moment it starts moving.
  const pull = PULL;
  const repulsion = REPULSION;
  const centre = { x: width / 2, y: height / 2 };

  for (let step = 0; step < iterations; step += 1) {
    // Cooling: big moves first, small corrections later. Without it the graph
    // never settles and the last iteration is as arbitrary as the first.
    const heat = 1 - step / iterations;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          // Two dots exactly on top of each other have no direction to push
          // apart in, and 0/0 poisons every later step with NaN.
          dx = (i % 2 ? 1 : -1) * 0.5;
          dy = 0.5;
          distance = Math.hypot(dx, dy);
        }
        // Dots: a plain radial clearance of the two radii plus GAP. No
        // per-axis rectangle maths — a circle has one extent in every
        // direction, which is the whole reason a dot layout settles cleaner
        // than the card one did.
        const clearance = (a.r ?? 6) + (b.r ?? 6) + GAP;
        if (distance < clearance) {
          const push = (clearance - distance) * 0.5;
          a.vx += (dx / distance) * push;
          a.vy += (dy / distance) * push;
          b.vx -= (dx / distance) * push;
          b.vy -= (dy / distance) * push;
        }
        const force = repulsion / (distance * distance);
        a.vx += (dx / distance) * force;
        a.vy += (dy / distance) * force;
        b.vx -= (dx / distance) * force;
        b.vy -= (dy / distance) * force;
      }
    }
    for (const edge of graph.edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const strength = pull[edge.kind] ?? pull.link;
      a.vx += (b.x - a.x) * strength;
      a.vy += (b.y - a.y) * strength;
      b.vx += (a.x - b.x) * strength;
      b.vy += (a.y - b.y) * strength;
    }
    for (const node of nodes) {
      // A faint pull to the middle, so disconnected notes drift to the edge
      // instead of off to infinity where no viewBox can find them.
      node.vx += (centre.x - node.x) * 0.004;
      node.vy += (centre.y - node.y) * 0.004;
      node.x += Math.max(-40, Math.min(40, node.vx)) * heat;
      node.y += Math.max(-40, Math.min(40, node.vy)) * heat;
      node.vx = 0;
      node.vy = 0;
    }
  }
  // Cooling scales the last corrections to nearly nothing, which is right for
  // the springs and wrong for collisions: it left a pair of cards overlapping
  // by a few units with no force left to separate them. Overlap is not a
  // preference to balance against the others, it is the one thing a card
  // layout may not do, so it gets its own uncooled pass at the end.
  separate(nodes);
  return nodes;
}

/**
 * Push overlapping dots apart at full strength. Deterministic: fixed passes,
 * fixed order, so the same workspace settles the same way.
 *
 * ponytail: O(n^2) per pass, stops at a fixed pass count, so at the very top
 * of the range a stray overlap can still survive in the densest spot. Dots
 * with a 12-unit hard gap have far more room to resolve than the old cards
 * did, so this holds comfortably to a few hundred.
 */
function separate(nodes, passes = 200) {
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.hypot(dx, dy);
        const minDist = (a.r ?? 6) + (b.r ?? 6) + HARD_GAP;
        if (distance >= minDist) continue;
        moved = true;
        const push = (minDist - distance) / 2 + 0.5;
        if (distance < 0.01) {
          // Two dots at the exact same point have no direction to separate in.
          const sign = i % 2 ? 1 : -1;
          a.x += sign * push;
          b.x -= sign * push;
        } else {
          a.x += (dx / distance) * push;
          a.y += (dy / distance) * push;
          b.x -= (dx / distance) * push;
          b.y -= (dy / distance) * push;
        }
      }
    }
    if (!moved) break;
  }
  return nodes;
}

// ------------------------------------------------------- the live physics
//
// `layout` above is the deterministic starting picture and stays that way. The
// simulation below CONTINUES from it: same forces, same constants, with the
// cooling schedule swapped for velocity damping so the graph can react to a
// drag and then come back to rest instead of stopping mid-motion at iteration
// 260. Nothing here ever runs before the first frame is drawn, so opening the
// graph twice on the same workspace still shows the same picture twice.

/**
 * One tick of the live simulation, in place, on nodes `layout` already placed.
 *
 * A node with `fixed === true` is held by the user (or parked by them) and is
 * never integrated: everything else moves around it, which is the whole point
 * of being able to drag one.
 *
 * Returns the mean squared displacement over the tick — the caller's cue that
 * the graph has stopped moving and the loop can stop with it.
 */
export function simulationStep(nodes, edges, { damping = 0.82, centre = null } = {}) {
  if (!nodes.length) return 0;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const middle = centre ?? {
    x: nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length,
    y: nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length,
  };

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.01) {
        // Two dots exactly on top of each other have no direction to push
        // apart in, and 0/0 poisons every later tick with NaN.
        dx = (i % 2 ? 1 : -1) * 0.5;
        dy = 0.5;
        distance = Math.hypot(dx, dy);
      }
      // Radial clearance, same as the one-shot layout. Only a small FRACTION
      // of the overlap is applied per tick: `layout` gets away with a full
      // 0.5 push because a cooled loop plus `separate`'s hard pass cleans up
      // the residue, and this live loop has neither. Any leftover overlap
      // recomputes at full strength next tick, so two dots pinned together by
      // a third neighbour would trade the same shove forever — the thing that
      // read as the graph fighting itself. A fraction still separates a pair
      // completely because it compounds every frame, but stays small enough
      // for damping to catch up with it.
      const clearance = (a.r ?? 6) + (b.r ?? 6) + GAP;
      if (distance < clearance) {
        const push = (clearance - distance) * 0.12;
        a.vx += (dx / distance) * push;
        a.vy += (dy / distance) * push;
        b.vx -= (dx / distance) * push;
        b.vy -= (dy / distance) * push;
      }
      const force = REPULSION / (distance * distance);
      a.vx += (dx / distance) * force;
      a.vy += (dy / distance) * force;
      b.vx -= (dx / distance) * force;
      b.vy -= (dy / distance) * force;
    }
  }
  for (const edge of edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    const strength = PULL[edge.kind] ?? PULL.link;
    a.vx += (b.x - a.x) * strength;
    a.vy += (b.y - a.y) * strength;
    b.vx += (a.x - b.x) * strength;
    b.vy += (a.y - b.y) * strength;
  }

  let energy = 0;
  for (const node of nodes) {
    // A very faint pull to the middle — just enough that a disconnected card
    // drifts back rather than off to infinity where no viewBox can find it.
    // Anything stronger and the whole graph creeps inward every tick, which
    // is what read as it "aggressively collapsing to the centre".
    node.vx += (middle.x - node.x) * 0.0006;
    node.vy += (middle.y - node.y) * 0.0006;
    if (node.fixed) {
      // Held or parked. Forces still reached it above and are discarded here,
      // so letting go does not release a spring that has been winding up.
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    // Damping, not cooling: this is what makes the graph settle rather than
    // jitter forever, and it recovers on its own when the user grabs a card.
    // The clamp has to land on the velocity itself, not just the position
    // delta below — clamping only the delta let a huge one-tick repulsion
    // (two cards spawned overlapping) survive in vx/vy at full strength
    // while displayed motion looked capped, so next tick's repulsion piled
    // more energy on top of it. Neighbours kept re-triggering each other's
    // leftover velocity every frame, which read as the whole graph fighting
    // itself. Clamping vx/vy directly lets damping actually burn it off.
    node.vx = Math.max(-40, Math.min(40, node.vx * damping));
    node.vy = Math.max(-40, Math.min(40, node.vy * damping));
    const dx = node.vx;
    const dy = node.vy;
    node.x += dx;
    node.y += dy;
    energy += dx * dx + dy * dy;
  }
  return energy / nodes.length;
}

/** Below this mean squared displacement per node the graph has visibly stopped
 * and the loop stops with it. A 60fps O(n^2) loop that never ends is a battery
 * bug, not a feature.
 *
 * Was 0.05 — chasing residual motion far below one visible pixel. Measured
 * (scratchpad, per the "verify physics empirically" rule) on a synthetic
 * 230-node/780-edge graph — the density a real, well-used workspace opens
 * the view on ("777 edges shown" on the live app) — the old threshold took
 * 1950 frames (~32.5s at 60fps) of O(n^2) work per frame to park itself,
 * long after the graph had visibly stopped moving. Damping alone barely
 * moved that number (0.75–0.88 all landed between ~700 and ~1950 frames at
 * this threshold) — the dominant lever is this threshold, not damping.
 * 0.5 (this value) with 0.82 damping (below) settles the same fixture in
 * ~330 frames (~5.5s), a ~6x cut, while 0.5 mean-squared-displacement is
 * still sub-pixel motion at the canvas scale `canvasFor()` uses. */
const REST_ENERGY = 0.5;
/** Consecutive resting ticks before the loop parks itself. A couple of frames
 * of stillness in the middle of a settle is normal; twelve is not. */
const REST_FRAMES = 12;
/** Share of the remaining distance the camera closes each frame while the graph settles. */
const FOLLOW_RATE = 0.06;
/** How far a pointer must travel, in client pixels, before a press on a card
 * becomes a drag instead of a click. Small enough that dragging feels
 * immediate, large enough that a click with an unsteady hand still opens the
 * note. */
const DRAG_THRESHOLD = 4;

/** A viewBox that contains every dot, with room for the biggest dot and the
 * label that hangs below it. */
export function boundsOf(nodes, margin = MAX_RADIUS + 34) {
  if (nodes.length === 0) return { x: 0, y: 0, width: 100, height: 100 };
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...xs) + margin - minX),
    height: Math.max(1, Math.max(...ys) + margin - minY),
  };
}

/** Dot size from how linked a note is, flattened so one hub does not become a
 * planet next to specks. Structural types (project, milestone, chapter…) start
 * larger because they are the landmarks the graph is read by. */
export function radiusOf(node) {
  const base = STRUCTURAL_TYPES.has(String(node?.type ?? "")) ? 7 : 4;
  return Math.min(MAX_RADIUS, base + Math.sqrt(Math.max(0, node?.degree ?? 0)) * 2.6);
}

// ---------------------------------------------------------------- drawing
//
// Titles are untrusted text: they arrive by sync and import like any other
// object title. Everything below is created as a node and filled through
// `textContent`; no markup is ever composed from a string. `self-check.mjs`
// greps this file for the markup-assigning properties and fails if one shows up.

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function element(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties);
  for (const child of children) node.append(child);
  return node;
}

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

async function readGraph(context) {
  const objects = await context.data.objects.query({ limit: MAX_NODES + 1 });
  // One index read for the whole workspace rather than one per note: the
  // per-object call would be hundreds of round trips on Core's single
  // mutex-guarded connection.
  const links = await context.data.index.query({ kind: "link", limit: 20_000 });
  const graph = buildGraph(objects, links);
  // Derived edges are appended, never merged into the stored ones: the drawing
  // and the legend both have to keep telling the two apart.
  const stored = new Set(graph.edges.map((edge) => (edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`)));
  graph.edges.push(...semanticEdges(graph.nodes, stored));
  return graph;
}

/**
 * Where a line from `from` to `to` should leave `from`'s dot: on the dot's
 * circumference, so the line touches the dot rather than vanishing under it or
 * floating short of it. `radius` defaults small for a bare {x, y}.
 */
export function nodeExit(from, to, radius = 6) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: from.x, y: from.y };
  return { x: from.x + (dx / distance) * radius, y: from.y + (dy / distance) * radius };
}

/** Human wording for one reason. Kept out of the drawing so the self-check can
 * assert on it without a DOM. */
export function reasonText(reason) {
  if (reason.kind === "tag") return `shared tags: ${reason.value}`;
  if (reason.kind === "keyword") return `shared words: ${reason.value}`;
  if (reason.kind === "parent") return "same container";
  return reason.kind;
}

function drawGraph(graph, { container, openObject }) {
  // The deterministic starting picture. The live loop below continues from it;
  // it never replaces it, so the same workspace always opens on the same shape.
  const positioned = layout(graph);
  const bounds = boundsOf(positioned);
  const byId = new Map(positioned.map((node) => [node.id, node]));
  // One hue per TYPE present on this canvas, resolved once so the cards and the
  // legend can never disagree. Deliberately not the root container's hue: in a
  // workspace where everything lives under one project — the common shape —
  // that painted every card the same colour and the legend showed one chip,
  // which told the reader nothing they did not already know.
  const hues = typeHues(positioned.map((node) => node.type));

  const canvas = svg("svg", {
    class: "ngraph-canvas",
    viewBox: `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": `Workspace graph: ${graph.nodes.length} notes`,
  });

  const edgeLayer = svg("g", { class: "ngraph-edges" });
  // Kept alongside the element so a frame can move a line without looking its
  // two ends up in a Map n times a second.
  const lines = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const line = svg("line", { class: `ngraph-edge ngraph-edge--${edge.kind}` });
    // Why these two are near each other, on hover and to a screen reader. The
    // whole point of the derived layer is that it can be challenged, which it
    // cannot be if the reason is not on the edge itself.
    if (edge.reasons?.length) {
      const why = document.createElementNS(SVG_NS, "title");
      why.textContent = [`${from.title} ~ ${to.title}`, "Suggested, not a stored link", ...edge.reasons.map(reasonText)].join("\n");
      line.append(why);
    }
    line.dataset.from = edge.from;
    line.dataset.to = edge.to;
    line.dataset.kind = edge.kind;
    if (typeof edge.score === "number") line.dataset.score = String(edge.score);
    // A stored link whose two ends live under different top-level containers —
    // the thing the sidebar tree cannot show, and the reason this plugin
    // exists. Marked here so the "crossing only" view can isolate them
    // without re-walking the tree.
    if (edge.kind === "link" && rootIdOf(edge.from, byId) !== rootIdOf(edge.to, byId)) {
      line.dataset.crossing = "yes";
    }
    edgeLayer.append(line);
    lines.push({ line, from, to });
  }
  canvas.append(edgeLayer);

  const nodeLayer = svg("g", { class: "ngraph-nodes" });
  const drawn = [];
  for (const node of positioned) {
    const group = svg("g", { class: "ngraph-node", tabindex: "0", role: "button" });
    group.dataset.free = node.free ? "yes" : "no";
    group.dataset.type = node.type;
    group.dataset.id = node.id;
    // Whether this node's label is drawn without a hover. High-degree nodes and
    // structural types (project, milestone, chapter…) are the landmarks the
    // graph is read by; everything else stays a bare dot until the pointer or
    // the lens reaches it, which is what keeps the canvas from being a cloud
    // of text.
    const alwaysLabel = node.degree >= LABEL_DEGREE_MIN || STRUCTURAL_TYPES.has(node.type);
    group.dataset.label = alwaysLabel ? "always" : "auto";
    // The hue rides on a custom property, resolved from the types present so no
    // colour literal ever lands in the stylesheet. The whole dot takes it now
    // (a card had a thin stripe; a dot is small enough to BE the colour), with
    // the type still spelled out in the hover title below.
    group.setAttribute("style", `--type-hue: ${hues.get(node.type) ?? 0}`);
    // A transparent disc under the visible dot: it is what the pointer,
    // hover and drag actually hit. A hollow "filed under nothing" ring
    // otherwise only catches events on its 1.5px stroke, so it had to be
    // aimed at to highlight even though dragging worked anywhere inside it.
    // Also a floor of 11 units, so the smallest degree-0 dots are not a
    // pinprick target either.
    const hit = svg("circle", { class: "ngraph-hit", r: Math.max(node.r + 3, 11) });
    group.append(hit);
    const dot = svg("circle", { class: "ngraph-dot", r: node.r });
    group.append(dot);
    // The title beside the dot. SVG <text> does not wrap or ellipsis, and a dot
    // graph does not want it to — a single trimmed line is the label, the full
    // title is in the hover <title>. Trim rather than clip so the ellipsis is
    // real text, not an overflow-hidden guess.
    const shown = node.title.length > 30 ? `${node.title.slice(0, 29)}…` : node.title;
    const label = svg("text", { class: "ngraph-label", "text-anchor": "middle" });
    label.textContent = shown;
    group.append(label);
    // Accessible name and the full title when it was trimmed. Names the type
    // the colour stands for, and the container the dot sits in.
    const root = node.free ? null : rootIdOf(node.id, byId);
    const rootTitle = root ? byId.get(root)?.title ?? null : null;
    const hover = document.createElementNS(SVG_NS, "title");
    hover.textContent = node.free
      ? `${node.title} — ${node.type}, not filed under anything`
      : rootTitle
        ? `${node.title} — ${node.type}, in ${rootTitle}`
        : `${node.title} — ${node.type}`;
    group.append(hover);

    const open = () => {
      // Swallow the click that ends a drag. Reset on the next pointerdown, so
      // a stray flag can never eat a later, genuine click.
      if (group.dataset.suppressClick === "yes") return;
      void openObject(node.id);
    };
    group.addEventListener("click", open);
    // Keyboard activation is untouched by the drag handling below: Enter and
    // Space still open the focused node.
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
    // The lens: hover or focus a node and everything unrelated fades out. Bound
    // to hover rather than to click because click already opens the note, and a
    // graph where selecting and opening are the same gesture cannot do both.
    const lensOn = () => setLens(node.id);
    const lensOff = () => setLens(null);
    group.addEventListener("pointerenter", lensOn);
    group.addEventListener("pointerleave", lensOff);
    group.addEventListener("focus", lensOn);
    group.addEventListener("blur", lensOff);
    group.addEventListener("pointerdown", (event) => grab(event, node, group));
    nodeLayer.append(group);
    drawn.push({ node, group, dot, label, hit });
  }
  canvas.append(nodeLayer);
  // Exposed so the mount function can build the legend without walking the
  // graph a second time. Alphabetical, which is both stable and the order
  // someone scanning a list of type names expects.
  canvas.types = [...new Set(positioned.map((node) => node.type))]
    .sort()
    .map((type) => ({ type, hue: hues.get(type) ?? 0 }));

  /** Push the model's positions into the DOM. Called once for the static
   * render, and once per frame while the simulation is running. */
  function place() {
    for (const item of drawn) {
      item.dot.setAttribute("cx", item.node.x);
      item.dot.setAttribute("cy", item.node.y);
      item.hit.setAttribute("cx", item.node.x);
      item.hit.setAttribute("cy", item.node.y);
      item.label.setAttribute("x", item.node.x);
      // Sits just under the dot, clear of a hub's radius.
      item.label.setAttribute("y", item.node.y + item.node.r + 11);
    }
    for (const item of lines) {
      const start = nodeExit(item.from, item.to, item.from.r);
      const finish = nodeExit(item.to, item.from, item.to.r);
      item.line.setAttribute("x1", start.x);
      item.line.setAttribute("y1", start.y);
      item.line.setAttribute("x2", finish.x);
      item.line.setAttribute("y2", finish.y);
    }
  }

  /** Fade everything that is not `id` or a direct neighbour of it. */
  function setLens(id) {
    if (!id) {
      canvas.removeAttribute("data-lens");
      return;
    }
    canvas.setAttribute("data-lens", "on");
    const neighbours = new Set([id]);
    for (const edge of graph.edges) {
      if (edge.from === id) neighbours.add(edge.to);
      else if (edge.to === id) neighbours.add(edge.from);
    }
    for (const group of nodeLayer.children) {
      group.dataset.lens = neighbours.has(group.dataset.id) ? "near" : "far";
    }
    for (const line of edgeLayer.children) {
      line.dataset.lens = line.dataset.from === id || line.dataset.to === id ? "near" : "far";
    }
  }

  // --- the live loop
  //
  // Two honest reasons to run nothing at all: the user asked for no motion, or
  // the workspace is big enough that an O(n^2) tick cannot fit in a frame. In
  // both cases the settled one-shot layout is drawn and that is the whole of
  // it — the picture is the same one, it simply does not move.
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tooLarge = positioned.length > LIVE_PHYSICS_MAX_NODES;
  const live = !reducedMotion && !tooLarge;
  canvas.physics = live ? "live" : reducedMotion ? "reduced-motion" : "too-large";
  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  let frame = null;
  let resting = 0;
  let held = 0;
  // The graph opens framed against the COOLED layout's bounds, then the live
  // loop eases it a little wider — which left it sitting small in a sea of
  // empty canvas. Re-fit once, the first time the loop parks, but only if the
  // user has not already taken the view somewhere themselves (a pan, a zoom or
  // a drag). `canvas.viewTouched` is set by addPanZoom and by `grab`.
  canvas.viewTouched = false;
  let autoFitted = false;
  let fitFrame = null;
  // A drag in flight owns three listeners on `window`, which outlive this SVG
  // if the user navigates away mid-gesture. Held so teardown can end them.
  const releaseGestures = new Set();
  // Set by teardown. `wake` is reachable from a release that teardown itself
  // triggers, so without this the last thing teardown does could be to start
  // the loop it just cancelled.
  let stopped = false;

  const tick = () => {
    const energy = simulationStep(positioned, graph.edges, { centre });
    place();
    resting = energy < REST_ENERGY ? resting + 1 : 0;
    // The camera follows the graph while it settles (untouched views only), so there is no
    // jump when the loop parks. Off with reduced motion: that graph is drawn settled anyway.
    if (!canvas.viewTouched && !reducedMotion) canvas.easeToFit?.(FOLLOW_RATE);
    // Park the loop once it has visibly stopped — unless a dot is being held,
    // where "not moving" only means the user is not moving their hand yet.
    if (resting >= REST_FRAMES && !held) {
      frame = null;
      if (!autoFitted) {
        autoFitted = true;
        // Finish the last stretch of the fit in a few eased frames rather than one cut.
        let guard = 0;
        const finishFit = () => {
          fitFrame = null;
          if (stopped || canvas.viewTouched) return;
          const left = canvas.easeToFit?.(0.18) ?? 0;
          guard += 1;
          if (left > 0.002 && guard < 60) fitFrame = requestAnimationFrame(finishFit);
          else canvas.fitView?.();
        };
        fitFrame = requestAnimationFrame(finishFit);
      }
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  /** Restart the loop after an interaction. Cheap to call: it is a no-op while
   * the loop is already running. */
  const wake = () => {
    if (stopped || !live || frame !== null) return;
    resting = 0;
    frame = requestAnimationFrame(tick);
  };

  /**
   * Client coordinates to user (viewBox) coordinates, asked of the SVG itself
   * rather than recomputed from the viewBox: pan and zoom already live in the
   * viewBox, and a second copy of that arithmetic here would be a second thing
   * to keep in step.
   */
  const toUser = (event) => {
    const matrix = canvas.getScreenCTM();
    if (!matrix) return null;
    const point = canvas.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(matrix.inverse());
  };

  /**
   * Press, then move: click or drag.
   *
   * `addPanZoom` ignores pointerdowns that land on a node so that nodes stay
   * clickable, and that still holds — this handler owns the gesture instead. A
   * pointer that never travels DRAG_THRESHOLD client pixels is a click and
   * opens the note, exactly as before. Past the threshold the dot is grabbed,
   * follows the cursor, and the click that the browser fires on release is
   * swallowed.
   *
   * ON RELEASE THE DOT STAYS PINNED, deliberately. You moved it there on
   * purpose; a dot that springs back the instant you let go makes the drag
   * pointless, and pinning is what lets someone pull one cluster clear of the
   * rest and read it. Pinned dots are marked so the state is visible rather
   * than silent, and reopening the graph starts from the deterministic layout
   * again — there is nothing to undo and nothing stored.
   */
  function grab(event, node, group) {
    if (event.button !== 0) return;
    delete group.dataset.suppressClick;
    const origin = toUser(event);
    if (!origin) return;
    const from = { x: event.clientX, y: event.clientY };
    const offset = { x: node.x - origin.x, y: node.y - origin.y };
    let dragging = false;

    const move = (moveEvent) => {
      if (!dragging) {
        if (Math.hypot(moveEvent.clientX - from.x, moveEvent.clientY - from.y) < DRAG_THRESHOLD) return;
        dragging = true;
        held += 1;
        node.fixed = true;
        group.dataset.dragging = "yes";
        // The user is arranging the graph by hand now — do not yank the view
        // out from under them when the loop next settles.
        canvas.viewTouched = true;
      }
      const point = toUser(moveEvent);
      if (!point) return;
      node.x = point.x + offset.x;
      node.y = point.y + offset.y;
      node.vx = 0;
      node.vy = 0;
      // With the loop running the rest of the graph reacts around the card on
      // the next frame. With it off — reduced motion, or too many cards — the
      // dragged card still moves, on its own, which is the honest subset.
      if (live) wake();
      else place();
    };
    const release = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      releaseGestures.delete(release);
      if (!dragging) return;
      held -= 1;
      delete group.dataset.dragging;
      group.dataset.pinned = "yes";
      group.dataset.suppressClick = "yes";
      wake();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    releaseGestures.add(release);
  }

  place();
  container.append(canvas);
  // Fitting reads the CURRENT positions, not the ones the graph opened on: once
  // cards have been dragged, "fit to window" has to mean the graph in front of
  // the user, not the one they started with.
  addPanZoom(canvas, bounds, () => boundsOf(positioned));
  wake();
  /**
   * Everything this surface owns outside its own DOM, ended in one call.
   *
   * This is the highest-risk line in the file. The graph runs a
   * `requestAnimationFrame` loop with an O(n^2) tick in it, and a rAF loop
   * outlives the node it was drawing into: navigating away from the view
   * without cancelling it leaves an invisible simulation burning a core for as
   * long as the app is open, with nothing on screen to show for it. The
   * resize observer and a drag's window listeners have the same shape — they
   * are held somewhere other than in the subtree Core removes.
   *
   * Releases run FIRST: a release wakes the loop, and waking a loop after
   * cancelling it is how a leak comes back through the door it was shown out
   * of. `stopped` is what makes that safe rather than merely ordered.
   */
  canvas.teardown = () => {
    stopped = true;
    for (const release of [...releaseGestures]) release();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (fitFrame !== null) cancelAnimationFrame(fitFrame);
    fitFrame = null;
    canvas.stopPanZoom?.();
  };

  /**
   * Show/hide edges without moving a single card.
   *
   * Deliberately NOT a relayout and deliberately not a nudge to the simulation
   * either: a control that reshuffles the map every notch makes it impossible
   * to see what the control did. Positions come from the layout and from the
   * user's own hands; the controls only change what is drawn over them.
   */
  canvas.applyFilter = ({ threshold = 0, layers }) => {
    let shown = 0;
    for (const line of edgeLayer.children) {
      const kind = line.dataset.kind;
      const score = Number(line.dataset.score || "0");
      const visible = (layers?.[kind] ?? true) && (kind !== "semantic" || score >= threshold);
      line.dataset.hidden = visible ? "no" : "yes";
      if (visible) shown += 1;
    }
    return shown;
  };

  /**
   * Hide whole types — the legend chips call this. Same rule as `applyFilter`:
   * it only changes what is drawn, it never moves a node or nudges the
   * simulation, so turning a type off and back on leaves the map exactly where
   * it was. An edge is hidden when EITHER end is a hidden type.
   */
  canvas.hiddenTypes = new Set();
  canvas.applyTypeFilter = () => {
    const hidden = canvas.hiddenTypes;
    for (const group of nodeLayer.children) {
      group.dataset.typeHidden = hidden.has(group.dataset.type) ? "yes" : "no";
    }
    for (const line of edgeLayer.children) {
      const a = byId.get(line.dataset.from);
      const b = byId.get(line.dataset.to);
      const gone = (a && hidden.has(a.type)) || (b && hidden.has(b.type));
      line.dataset.typeHidden = gone ? "yes" : "no";
    }
  };
  return canvas;
}

/**
 * Drag to pan, wheel to zoom, double-click to fit. All of it is the viewBox:
 * no transform to keep in step with hit testing, and stroke widths stay in
 * user units so a zoomed-in graph does not grow fat lines.
 *
 * `boundsNow` is a function rather than a value because cards can be dragged:
 * "fit to window" has to frame the graph as it stands, not as it opened. The
 * zoom limits stay pinned to the opening bounds, so how far in and out the
 * wheel can go does not change under the user as they move things.
 *
 * ponytail: no inertia, no animation, no pinch — a trackpad reports pinch as a
 * ctrl+wheel, which this already handles.
 */
function addPanZoom(canvas, fit, boundsNow = null) {
  let view = { ...fit };
  const apply = () => canvas.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);

  /** One client pixel in user units. The canvas is `xMidYMid meet`, so the
   * scale is the SAME on both axes: the tighter fit of the two wins. */
  const perPixel = () => {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return view.width / 1000;
    return Math.max(view.width / box.width, view.height / box.height);
  };

  let dragging = null;
  canvas.addEventListener("pointerdown", (event) => {
    // Left button only, and not on a dot: a press on a dot is that dot's own
    // gesture — a click that opens the note, or a drag that moves it.
    if (event.button !== 0 || event.target.closest(".ngraph-node")) return;
    dragging = { x: event.clientX, y: event.clientY, scale: perPixel() };
    canvas.setPointerCapture(event.pointerId);
    canvas.dataset.panning = "yes";
    // A deliberate pan: the settle-time auto-fit must not override it.
    canvas.viewTouched = true;
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    view.x -= (event.clientX - dragging.x) * dragging.scale;
    view.y -= (event.clientY - dragging.y) * dragging.scale;
    dragging.x = event.clientX;
    dragging.y = event.clientY;
    apply();
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    delete canvas.dataset.panning;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("wheel", (event) => {
    // The pane scrolls, and so does the modal body; without this the wheel
    // scrolls whichever of them the graph is sitting in instead of zooming.
    event.preventDefault();
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    canvas.viewTouched = true;
    const factor = Math.exp(event.deltaY * 0.0015);
    // Bounded so the graph cannot be zoomed into a single pixel or out of
    // sight, either of which leaves the user with no way back but the button.
    const width = Math.min(fit.width * 8, Math.max(fit.width / 40, view.width * factor));
    const scale = width / view.width;
    // Keep whatever is under the pointer under the pointer.
    const px = (event.clientX - box.left) / box.width;
    const py = (event.clientY - box.top) / box.height;
    view = {
      x: view.x + (view.width - view.width * scale) * px,
      y: view.y + (view.height - view.height * scale) * py,
      width: view.width * scale,
      height: view.height * scale,
    };
    apply();
  }, { passive: false });

  /**
   * Rewrite the view so its aspect ratio matches the element's, keeping the
   * centre and one user-units-per-pixel scale.
   *
   * The canvas no longer has a size of its own: in the pane it is whatever the
   * flex column leaves it, which changes every time the window does. Under
   * `xMidYMid meet` a mismatched view is letterboxed rather than clipped, so
   * nothing is ever lost — but the empty margin is real estate the graph could
   * have used, and `perPixel` below has to take the tighter of the two ratios
   * to stay honest about it. Matching the aspect makes the two ratios equal,
   * which is what keeps a pan tracking the pointer exactly after a resize.
   *
   * `against` is the box the current view was framed for. Passing the previous
   * size holds the SCALE still, so widening the window shows more graph rather
   * than magnifying the graph already on screen — the thing a map should do.
   * Passing nothing measures against the box as it is now, which is what "fit"
   * means.
   */
  let lastBox = null;
  const reframe = (against = null) => {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) { apply(); return; }
    const gauge = against?.width && against?.height ? against : box;
    const scale = Math.max(view.width / gauge.width, view.height / gauge.height);
    const centreX = view.x + view.width / 2;
    const centreY = view.y + view.height / 2;
    view = {
      x: centreX - (scale * box.width) / 2,
      y: centreY - (scale * box.height) / 2,
      width: scale * box.width,
      height: scale * box.height,
    };
    lastBox = { width: box.width, height: box.height };
    apply();
  };

  canvas.fitView = () => { view = { ...(boundsNow ? boundsNow() : fit) }; reframe(); };
  /** The view that fitView would land on, without moving to it. */
  const fitTarget = () => {
    const saved = view;
    view = { ...(boundsNow ? boundsNow() : fit) };
    reframe();
    const target = view;
    view = saved;
    return target;
  };
  /**
   * Move a fraction `rate` of the way to the fitted view; returns how far is left (0 = arrived,
   * as a share of the view width). Called every frame while the graph settles, so the camera
   * follows the graph as it spreads instead of jumping to the fit the moment it stops.
   */
  canvas.easeToFit = (rate) => {
    const to = fitTarget();
    const left = Math.max(Math.abs(to.x - view.x), Math.abs(to.y - view.y), Math.abs(to.width - view.width)) / (view.width || 1);
    view = {
      x: view.x + (to.x - view.x) * rate,
      y: view.y + (to.y - view.y) * rate,
      width: view.width + (to.width - view.width) * rate,
      height: view.height + (to.height - view.height) * rate,
    };
    apply();
    return left;
  };
  canvas.addEventListener("dblclick", () => canvas.fitView());
  reframe();

  // An observer is held by the browser, not by the subtree Core removes, so it
  // is one of the two things here that leak if nobody ends them.
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => reframe(lastBox)) : null;
  observer?.observe(canvas);
  canvas.stopPanZoom = () => observer?.disconnect();
}

/**
 * The whole surface — stats, controls, canvas, legend — built once and mounted
 * into whatever element it is handed.
 *
 * There is exactly one implementation because there are two envelopes for it:
 * the registered view, which is where every entry point sends the user, and
 * the modal that a host unable to render views falls back to. Two copies of a
 * surface this size drift, and the half that drifts is always the one nobody
 * opened while working on the other.
 *
 * `variant` reaches only the CSS: "pane" stretches to fill Core's card, "modal"
 * carries the envelope arithmetic a modal needs and a pane must not have.
 *
 * Returns a Disposable, and it is load-bearing — see `canvas.teardown`.
 */
function mountSurface(context, { container, openObject }, { variant }) {
  const root = element("div", { className: `ngraph ngraph--${variant}` });
  root.append(element("style", { textContent: styles }));
  const shell = element("div", { className: "ngraph-shell" });
  root.append(shell);
  container.append(root);

  let disposed = false;
  // Held so dispose can end the animation frame, the resize observer and
  // any drag still in flight. A rAF loop outlives the node it was drawing
  // into and would keep an O(n^2) tick running against a detached SVG for
  // as long as the app is open.
  let drawnCanvas = null;
  shell.append(text("p", "Reading the workspace…", "ngraph-note"));

  void (async () => {
    let graph;
    try {
      graph = await readGraph(context);
    } catch (cause) {
      // invoke rejects with strings rather than Errors, so cause.message is
      // often undefined; show what actually came back.
      if (!disposed) shell.replaceChildren(text("p", String(cause?.message ?? cause), "ngraph-note"));
      return;
    }
    // Anything awaited can finish after the surface is gone — a modal
    // closed, or a view navigated away from. Drawing into a detached
    // container is invisible at best and, on a re-mount, draws the graph
    // twice.
    if (disposed) return;

    shell.replaceChildren();
    const free = graph.nodes.filter((node) => node.free).length;
    const crossing = crossingLinks(graph).length;
    // Totals are context, not the point of the screen — a closed disclosure
    // that rides at the end of the one control row rather than its own line.
    const stats = element("details", { className: "ngraph-stats-wrap" });
    stats.append(text("summary", "Totals"));
    stats.append(element("p", { className: "ngraph-stats" }, [
      text("strong", String(graph.nodes.length)),
      text("span", " notes · "),
      text("strong", String(graph.edges.filter((edge) => edge.kind === "link").length)),
      text("span", " links, "),
      text("strong", String(crossing)),
      text("span", " of them across containers · "),
      text("strong", String(free)),
      text("span", " filed under nothing · "),
      text("strong", String(graph.edges.filter((edge) => edge.kind === "semantic").length)),
      text("span", " suggested"),
    ]));

    if (graph.nodes.length === 0) {
      shell.append(text("p", "Nothing to draw yet.", "ngraph-note"));
      return;
    }

    const board = element("div", { className: "ngraph-board" });
    const controls = element("div", { className: "ngraph-controls" });
    shell.append(controls, board);
    if (graph.truncated) {
      shell.append(text("p", `Showing the first ${graph.nodes.length} of ${graph.total} objects.`, "ngraph-note"));
    }
    const canvas = drawGraph(graph, { container: board, openObject });
    drawnCanvas = canvas;

    const layers = { link: true, parent: true, semantic: true };
    const threshold = 0;
    const shownCount = text("span", "", "ngraph-shown");
    const refresh = () => {
      const shown = canvas.applyFilter({ threshold, layers });
      shownCount.textContent = `${shown} edges shown`;
    };

    // A rounded-rectangle toggle button. The <input type="checkbox"> is still
    // the control — laid over the whole button at zero opacity so the pointer
    // hits it and the keyboard and screen reader keep working; the button is
    // paint. On/off rides on a data attribute set by the same handler.
    const makeToggle = (label, initial, onChange) => {
      const box = element("input", { type: "checkbox", checked: initial });
      const toggle = element("label", { className: "ngraph-toggle" });
      toggle.dataset.on = initial ? "yes" : "no";
      box.addEventListener("change", () => {
        toggle.dataset.on = box.checked ? "yes" : "no";
        onChange(box.checked);
      });
      toggle.append(box, text("span", label));
      return toggle;
    };

    // Which edge kinds are drawn.
    const layerGroup = element("div", { className: "ngraph-group ngraph-group--layers" });
    for (const [kind, label] of [["link", "Links"], ["parent", "Inside"], ["semantic", "Suggested"]]) {
      layerGroup.append(makeToggle(label, true, (on) => { layers[kind] = on; refresh(); }));
    }
    controls.append(layerGroup);
    controls.append(element("div", { className: "ngraph-sep" }));

    // The two views this plugin exists for: links that leave their container,
    // and notes filed under nothing. Both are pure show/hide over the same
    // positions — a data attribute on the canvas, the rest is CSS.
    const viewGroup = element("div", { className: "ngraph-group ngraph-group--views" });
    viewGroup.append(makeToggle("Crossing only", false, (on) => {
      if (on) canvas.dataset.crossingOnly = "yes"; else delete canvas.dataset.crossingOnly;
    }));
    viewGroup.append(makeToggle("Unfiled only", false, (on) => {
      if (on) canvas.dataset.unfiledOnly = "yes"; else delete canvas.dataset.unfiledOnly;
    }));
    controls.append(viewGroup);

    // Everything else on the same row, pushed to the right: the edge count,
    // the fit button, and Totals as a trailing disclosure. One toolbar above
    // the canvas instead of three stacked strips of small controls.
    controls.append(element("div", { className: "ngraph-group ngraph-group--meta" }, [
      shownCount,
      element("button", {
        type: "button",
        className: "ngraph-fit",
        textContent: "Fit to window",
        onclick: () => canvas.fitView(),
      }),
      stats,
    ]));
    refresh();
    // Edge kinds first, with a word each on hover — the three keys on their
    // own read as jargon.
    const edgeKey = (cls, label, gloss) => {
      const chip = element("span", { className: `ngraph-key ${cls}` }, [text("span", label)]);
      chip.title = gloss;
      return chip;
    };
    const legend = element("p", { className: "ngraph-legend" });
    legend.append(
      text("span", "Edges", "ngraph-legend-label"),
      edgeKey("ngraph-key--link", "Link", "A [[wikilink]] you wrote between two notes."),
      edgeKey("ngraph-key--parent", "Inside", "A note filed inside a container (folder or project)."),
      edgeKey("ngraph-key--semantic", "Suggested", "Notible's guess from shared words — not a stored link."),
      edgeKey("ngraph-key--free", "Filed under nothing", "A note with no container."),
      text("span", "Types", "ngraph-legend-label"),
    );
    // The type chips are FILTERS now, not just a key: click one to drop that
    // type (and its edges) from the canvas, click again to bring it back — the
    // way someone reads a dense graph is by turning the noise off. It is a real
    // <button> so the keyboard and screen reader work; `data-off` carries the
    // state so the same code that changes it also paints it.
    // A plugin type is namespaced (`notible.typewriter.chapter`); the chip
    // shows the last segment, capitalized (bare plugin type names are
    // lower_snake_case; a raw `chapter` chip read as a typo next to `Note`
    // and `Project` everywhere else in the app — same fix as Core's
    // typeLabel()), full raw name on hover.
    const shortType = (type) => (type.includes(".") ? type.slice(type.lastIndexOf(".") + 1) : type);
    const capitalize = (label) => label.charAt(0).toUpperCase() + label.slice(1);
    const TYPE_LEGEND_CAP = 14;
    for (const entry of canvas.types.slice(0, TYPE_LEGEND_CAP)) {
      const chip = element("button", { type: "button", className: "ngraph-key ngraph-key--type" }, [text("span", capitalize(shortType(entry.type)))]);
      chip.style.setProperty("--type-hue", String(entry.hue));
      chip.title = `${entry.type} — click to hide`;
      chip.dataset.off = "no";
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        const off = chip.dataset.off !== "yes";
        chip.dataset.off = off ? "yes" : "no";
        chip.setAttribute("aria-pressed", off ? "true" : "false");
        chip.title = `${entry.type} — click to ${off ? "show" : "hide"}`;
        if (off) canvas.hiddenTypes.add(entry.type);
        else canvas.hiddenTypes.delete(entry.type);
        canvas.applyTypeFilter();
      });
      legend.append(chip);
    }
    if (canvas.types.length > TYPE_LEGEND_CAP) {
      const rest = canvas.types.slice(TYPE_LEGEND_CAP);
      const more = text("span", `+${rest.length} more`, "ngraph-note ngraph-key--more");
      more.title = rest.map((entry) => capitalize(shortType(entry.type))).join(", ");
      legend.append(more);
    }
    shell.append(legend);
    shell.append(text("p", "Drag the background to pan, scroll to zoom, double-click to fit. Drag a dot to move it — it stays where you put it. Click a dot, or focus it and press Enter, to open the note. Click a type in the legend to hide it. “Crossing only” isolates links that leave their container; “unfiled only”, the notes filed under nothing.", "ngraph-note"));
    // If the physics is off, say why. Silently shipping a still graph and
    // letting the user wonder whether dragging is broken is the failure
    // this note exists to prevent.
    if (canvas.physics === "too-large") {
      shell.append(text("p", `Live physics is off above ${LIVE_PHYSICS_MAX_NODES} dots: the force model is O(n²) per frame and would not fit in one at this size. Dots can still be dragged one at a time.`, "ngraph-note"));
    }
    if (canvas.physics === "reduced-motion") {
      shell.append(text("p", "Reduced motion is on, so the graph is drawn settled and does not animate. Dots can still be dragged one at a time.", "ngraph-note"));
    }
  })();

  return { dispose: () => { disposed = true; drawnCanvas?.teardown?.(); root.remove(); } };
}

/**
 * The surface in a modal — the fallback, and only that.
 *
 * A host that renders no views at all still has to be able to show the graph,
 * and `ui.modal` is the one envelope every host has. It is not the destination
 * any more, so nothing calls it directly except `showGraph`.
 */
function openGraphModal(context) {
  context.ui.modal({
    title: "Workspace graph (alpha)",
    mount: (host) => mountSurface(context, host, { variant: "modal" }),
  });
}

/**
 * The single way in for the sidebar button and the command: the pane if this
 * host has one, the modal if it has not.
 *
 * `ui.openView` (API 1.8) navigates the shell to this plugin's own registered
 * view — the id is resolved against our own registrations, so "surface" here
 * is the one `onload` registers below and can never be someone else's screen.
 * It resolves `false` only when the host has nowhere to render views, which is
 * the only case worth a fallback; both entry points come through here so that
 * fallback is written once rather than twice, and cannot rot in the copy
 * nobody exercised.
 *
 * Both callers are synchronous click handlers, so the promise has to be dealt
 * with here or not at all: an unhandled rejection inside a click handler goes
 * to the console nobody has open, and the button reads as broken. A rejection
 * is NOT retried in the modal, deliberately. `openView` rejects for a view id
 * this plugin never registered — a programming error — or for a permission we
 * declare and should have; quietly opening the modal instead would hide a bug
 * behind a working-looking window, which is exactly how the nav card ends up
 * never being used. So it is said out loud, in the one channel a plugin has
 * for a sentence the user should see.
 */
function showGraph(context) {
  void context.ui.openView("surface").then((shown) => {
    if (!shown) openGraphModal(context);
  }).catch((cause) => {
    // invoke rejects with strings rather than Errors, as elsewhere here.
    context.ui.notice(`Could not open the graph: ${String(cause?.message ?? cause)}`);
  });
}

// ------------------------------------------------------------------- CSS
/*
 * Public token contract (--notible-*), no colour literals, so
 * `scripts/plugin-css-token-check.mjs` passes and the graph follows the theme.
 * House rules: outline over fill, no coloured ribbon, no card in a card.
 */
const styles = `
.ngraph { color: var(--notible-text); font-size: 13px; }
/* In the pane the plugin's own root IS the flex child of Core's card — the
   mount around it is display:contents — so it stretches and paints nothing:
   no background, no border, no radius. Core's pane already draws all three,
   and a second one inside it is a card in a card. */
.ngraph--pane { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; }
/* The rows have their natural height and the canvas takes the rest. No
   viewport arithmetic: the height of Core's chrome is Core's business, and a
   guess at it here is a number that is wrong the next time a toolbar moves. */
.ngraph-shell { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ngraph--pane .ngraph-shell { flex: 1; min-height: 0; }
/* The modal is the one envelope that really is measured against the viewport,
   because Core sizes it against the viewport: width:fit-content capped at
   calc(100vw - 48px). The subtraction leaves room for those 48px, the 16px of
   mount padding on each side and the modal's own border, so the shell can
   never be the thing that overflows. This rule is scoped to the modal on
   purpose — it was what made the graph read as a small floating box, and it
   must not follow the surface into the pane. */
.ngraph--modal .ngraph-shell { width: min(1600px, calc(100vw - 96px)); }
/* Totals sits at the end of the toolbar as a disclosure whose body is a
   right-aligned popover — absolute, so opening it never pushes the row wider
   or the canvas down (the bug on the first pass). */
.ngraph-stats-wrap { position: relative; color: var(--notible-muted); font-size: 12px; }
.ngraph-stats-wrap > summary { width: fit-content; cursor: pointer; list-style: none; color: var(--notible-muted); text-transform: uppercase; letter-spacing: .04em; font-size: 11px; font-weight: 600; }
.ngraph-stats-wrap > summary::-webkit-details-marker { display: none; }
.ngraph-stats-wrap > summary::before { content: "\\25B8  "; }
.ngraph-stats-wrap[open] > summary::before { content: "\\25BE  "; }
.ngraph-stats {
  position: absolute;
  top: calc(100% + 7px);
  right: 0;
  z-index: 4;
  width: max-content;
  max-width: min(340px, 60vw);
  margin: 0;
  padding: 9px 12px;
  border: 1px solid var(--notible-border);
  border-radius: 8px;
  background: var(--notible-surface);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .16);
  color: var(--notible-muted);
  line-height: 1.6;
  font-variant-numeric: tabular-nums;
}
.ngraph-stats strong { color: var(--notible-text); }
.ngraph-legend-label { color: var(--notible-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.ngraph-key--more { cursor: help; }
.ngraph-note { margin: 0; color: var(--notible-muted); font-size: 12px; line-height: 1.5; }
/* The board is what has a size; the canvas fills it absolutely rather than
   reporting one of its own. An SVG that contributes its own height to a flex
   column can only ever argue with the column about who decides. */
.ngraph-board { position: relative; border: 1px solid var(--notible-border); border-radius: 10px; overflow: hidden; }
/* In the pane: everything the fixed rows leave, down to a floor below which a
   graph is not a graph. */
.ngraph--pane .ngraph-board { flex: 1 1 auto; min-height: 220px; }
/* In the modal there is no pane to fill, so the board keeps a height of its
   own. Core caps the modal at min(88vh, 900px); the rows above and below the
   canvas — the modal header, the mount padding, the stats line, the controls,
   the legend and the notes — measure about 230px together, so 250px is
   subtracted with a little to spare and the ceiling is 650px, not the 900px
   the modal itself allows. */
.ngraph--modal .ngraph-board { height: clamp(320px, 88vh - 250px, 650px); }
.ngraph-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.ngraph-canvas[data-panning="yes"] { cursor: grabbing; }
/* Filled bordo rounded rectangle — the same treatment Core gives its own
   chrome buttons. */
.ngraph-fit { border: 0; border-radius: 999px; height: 26px; background: var(--notible-accent); padding: 0 14px; color: var(--notible-on-accent); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.ngraph-fit:hover { background: var(--notible-accent-hover); }
.ngraph-fit:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 2px; }
/* Edges rest FAINT — the point of the graph is the shape of the network, and
   at full strength a few hundred lines are the hairball. They come up to full
   only under the lens (hover a node). Suggested edges read as weaker than
   stored ones at every state: thinner, dashed. A guess that looks like a fact
   is worse than no guess. */
.ngraph-edge { stroke-width: 1; stroke: var(--notible-muted); }
.ngraph-edge--link { opacity: .28; }
.ngraph-edge--parent { stroke: var(--notible-border); stroke-dasharray: 4 3; opacity: .2; }
.ngraph-edge--semantic { stroke-width: 0.7; stroke-dasharray: 2 4; opacity: .16; }

/* A node is a dot the size of its degree, filled with its type's hue. The hue
   rides on --type-hue (set per node in JS from the types present), so no colour
   literal lands here. A mid lightness / moderate saturation reads on both
   themes' surfaces (a light cream and a dark brown, per core-only.css). The
   surface-coloured ring is a 1.5px moat that keeps touching dots legible. */
.ngraph-node { cursor: pointer; }
/* The real hit target: a transparent disc that covers the whole node, so
   hover, click and drag all land the same way whether the visible dot is a
   fill or a hollow "filed under nothing" ring. It sits under the visible dot,
   so it never paints over it. */
.ngraph-hit { fill: transparent; }
.ngraph-dot { fill: hsl(var(--type-hue) 55% 52%); stroke: var(--notible-surface); stroke-width: 1.5; pointer-events: none; }
/* Filed under nothing: a hollow ring instead of a fill, so "unfiled" reads
   without relying on the hue. */
.ngraph-node[data-free="yes"] .ngraph-dot { fill: none; stroke: hsl(var(--type-hue) 45% 50%); stroke-width: 1.5; stroke-dasharray: 2 2; }
.ngraph-node:hover .ngraph-dot,
.ngraph-node:focus-visible .ngraph-dot { stroke: var(--notible-accent); stroke-width: 2; }
/* A dot the user has parked, and one being dragged — states the user would
   otherwise be in without being able to see it. */
.ngraph-node[data-pinned="yes"] .ngraph-dot { stroke: var(--notible-accent); }
.ngraph-node[data-dragging="yes"] { cursor: grabbing; }
.ngraph-node[data-dragging="yes"] .ngraph-dot { stroke: var(--notible-accent); stroke-width: 2.5; }
.ngraph-node:focus-visible { outline: none; }

/* The label. Drawn for every node, shown only for the ones that carry the
   structure of the graph (high degree, or a structural type) or the one under
   the pointer / lens — otherwise the canvas is a wall of text. paint-order +
   a surface-coloured stroke give it a halo so it stays readable over edges. */
.ngraph-label {
  fill: var(--notible-muted);
  font-size: 10px;
  pointer-events: none;
  paint-order: stroke;
  stroke: var(--notible-surface);
  stroke-width: 3px;
  stroke-linejoin: round;
  opacity: 0;
  transition: opacity .1s ease;
}
.ngraph-node[data-label="always"] .ngraph-label { opacity: 1; fill: var(--notible-text); }
.ngraph-node:hover .ngraph-label,
.ngraph-node:focus-visible .ngraph-label { opacity: 1; fill: var(--notible-text); }

/* The lens. Hovering a node dims everything it has no edge to, so a dense
   region can be read one object at a time, and brings its own edges and
   neighbours up to full — including their labels. */
.ngraph-canvas[data-lens="on"] .ngraph-node[data-lens="far"] { opacity: .1; }
.ngraph-canvas[data-lens="on"] .ngraph-edge[data-lens="far"] { opacity: .04; }
.ngraph-canvas[data-lens="on"] .ngraph-edge[data-lens="near"] { opacity: 1; }
.ngraph-canvas[data-lens="on"] .ngraph-node[data-lens="near"] .ngraph-label { opacity: 1; fill: var(--notible-text); }
.ngraph-edge[data-hidden="yes"] { display: none; }
/* A whole type turned off from the legend. */
.ngraph-node[data-type-hidden="yes"],
.ngraph-edge[data-type-hidden="yes"] { display: none; }
/* "crossing only": keep just the stored links whose ends are under different
   containers — the sidebar-tree blind spot. Dots stay so you can see which
   notes are involved. */
.ngraph-canvas[data-crossing-only="yes"] .ngraph-edge:not([data-crossing="yes"]) { display: none; }
/* "unfiled only": just the notes filed under nothing, and no edges (an
   orphan's links, if any, go to notes that are now hidden). */
.ngraph-canvas[data-unfiled-only="yes"] .ngraph-node:not([data-free="yes"]) { display: none; }
.ngraph-canvas[data-unfiled-only="yes"] .ngraph-edge { display: none; }

/* The control row, as furniture rather than as three stray form controls.
   Everything paints from the --notible-* tokens, so it is the app's own cream
   and burgundy in light and the app's own browns in night, with no literal
   anywhere for a theme to fail to reach. */
/* One toolbar strip directly above the canvas: filter toggles on the left,
   the edge count, Fit and the Totals popover on the right. */
.ngraph-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--notible-muted); font-size: 12px; }
.ngraph-group { display: inline-flex; align-items: center; gap: 6px; }
.ngraph-group--meta { position: relative; margin-left: auto; gap: 8px; }
/* A thin rule takes the place of the old bordered group boxes — "layers"
   still reads as a separate cluster from "views" without either group
   getting a container of its own. */
.ngraph-sep { width: 1px; align-self: stretch; margin: 2px 2px; background: var(--notible-border); }

/* A toggle is the same flat pill Core's own search-filter chips use
   (0.83.6): no border by default, a filled background on hover, an
   accent-tinted fill when on — one control family instead of the plugin
   inventing its own outlined-pill look. The checkbox is still the control,
   laid over the whole button at zero opacity so the pointer hits the input
   and the keyboard and screen reader keep working. */
.ngraph-toggle { position: relative; display: inline-flex; align-items: center; height: 26px; border-radius: 999px; padding: 0 10px; background: var(--notible-hover); color: var(--notible-text); cursor: pointer; user-select: none; transition: background-color 140ms ease, color 140ms ease; }
.ngraph-toggle input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; border-radius: 999px; opacity: 0; cursor: pointer; }
/* On/off is a filled dot against an empty ring as well as a change of colour,
   for anyone who cannot separate hues. */
.ngraph-toggle span::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--notible-faint); vertical-align: middle; }
.ngraph-toggle:hover { background: var(--notible-active); }
.ngraph-toggle[data-on="yes"] { background: var(--notible-selected); color: var(--notible-accent); font-weight: 600; }
.ngraph-toggle[data-on="yes"] span::before { background: var(--notible-accent); }
.ngraph-toggle input:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 1px; }

.ngraph-shown { color: var(--notible-faint); font-variant-numeric: tabular-nums; }
.ngraph-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; color: var(--notible-muted); font-size: 12px; }
.ngraph-legend + .ngraph-legend { margin-top: -2px; }
.ngraph-key { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; }
.ngraph-key::before { content: ""; width: 14px; height: 0; border-top: 1px solid var(--notible-muted); }
.ngraph-key--parent::before { border-top-style: dashed; border-color: var(--notible-border); }
.ngraph-key--free::before { width: 8px; height: 8px; border: 1px dashed var(--notible-muted); border-radius: 50%; }
.ngraph-key--semantic::before { border-top-style: dotted; border-color: var(--notible-muted); opacity: .6; }
/* The type chips are buttons — filters, not just a key — and now share the
   toolbar toggle's flat-pill shape above, so the legend and the toolbar read
   as one control family instead of two. data-off strikes the chip through
   and fades it so a hidden type is obvious at a glance. */
.ngraph-key--type { border: 0; border-radius: 999px; height: 24px; background: var(--notible-hover); padding: 0 9px 0 7px; color: var(--notible-text); font: inherit; font-size: 12px; cursor: pointer; transition: background-color 140ms ease; }
.ngraph-key--type::before { width: 8px; height: 8px; border: 0; border-radius: 50%; background: hsl(var(--type-hue) 55% 52%); }
.ngraph-key--type:hover { background: var(--notible-active); }
.ngraph-key--type:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 1px; }
.ngraph-key--type[data-off="yes"] { background: none; color: var(--notible-faint); text-decoration: line-through; }
.ngraph-key--type[data-off="yes"]::before { background: var(--notible-faint); }
`;

export default {
  // Core reads plugin.json, shows it to the user, then refuses an entry module
  // claiming a different identity. `self-check.mjs` keeps the two in step.
  manifest: {
    id: "notible.graph",
    name: "Notible Graph",
    version: "0.11.5",
    apiVersion: "1.8",
    description: "ALPHA — a map of the workspace: every object is a dot sized by how connected it is, coloured by its type, placed near what it relates to. Titles show for the dots that carry the structure and for whatever the pointer is over. Draws three kinds of edge and keeps them apart: containment, stored [[wikilinks]], and suggested edges from shared tags and title words, drawn weaker and always saying why. Hover a dot to fade everything it has no edge to; click a type in the legend to hide it. Built to show what the sidebar tree cannot: links that cross project boundaries, objects filed under nothing, and objects about the same thing that nobody linked. The visual design is still settling.",
    author: "Notible",
    permissions: ["data.read", "workspace.ui"],
  },

  onload(context) {
    this._disposables = [];

    // The home: a registered view, which CoreOnlyApp renders as a nav entry
    // beside Notes opening a full-width pane. `mount` is what draws it — a
    // registration without one gets a nav entry and a pane saying the view
    // registered no mount. The id is slug-like and stays stable: it lands in
    // the section string and in a data-plugin-view attribute, so changing it
    // is changing a URL.
    this._disposables.push(context.views.register({
      id: "surface",
      title: "Graph",
      // A whole workspace tool, not a settings screen — opts into a nav card.
      nav: true,
      navIcon: "network",
      mount: (host) => mountSurface(context, host, { variant: "pane" }),
    }));

    // The command below sends the user to the view registered above, through
    // `showGraph`. It opened the modal until 0.7.0, because until API 1.8
    // nothing navigated the shell to a plugin's own view; the modal is now
    // what a host that renders no views falls back to, and nothing else.
    // There used to also be a duplicate open-Graph button in the bottom
    // sidebar slot — removed in 0.8.0 since the nav card above is the same
    // one click away and having both just doubled the entry point.
    this._disposables.push(context.commands.register({
      id: "open",
      name: "Graph: map the workspace",
      description: "Notes as dots, links as lines. Alpha. Opens the Graph pane, the same one the nav entry does.",
      execute: () => showGraph(context),
    }));
  },

  onunload() {
    for (const disposable of this._disposables ?? []) disposable.dispose?.();
    this._disposables = [];
  },
};
