# Notible Graph — alpha

A map of the workspace: every note a dot, every `[[wikilink]]` a line, notes
that live in the same project pulled into the same clump.

**This is an alpha, and the word is in the market description on purpose.** The
data side is finished and checked; the *look* is only part-way. The layout is
still the simplest thing that puts related notes near each other, and plenty
below is admitted as unfinished. Expect it to change.

Nothing leaves the machine: no `network` permission, and it only ever reads.

## What it is not

It is not Obsidian's graph. There the graph is the only structure, because
there is no hierarchy. Notible already has workspaces, projects and folders,
and they carry most of the meaning — so tipping every note into one cloud of
dots would **delete** information you already have. So there are two kinds of
edge:

| Edge | Drawn | Meaning |
|---|---|---|
| containment | faint dashed | this note lives inside that project or folder |
| link | plain line | a `[[wikilink]]` between two notes |
| suggested | faint dotted | Notible's guess from shared tags and title words — says why on hover |

Containment pulls harder than a link, so a project reads as a clump and a link
between two projects reads as a line stretched between them.

The point is the two things the sidebar tree cannot show you:

- **links that cross container boundaries** — counted in the header line;
- **notes filed under nothing** — drawn as a dashed outline, also counted.

## Using it

The graph's home is **Graph** in the navigation, next to Notes: a full-width
pane, not a floating window. A map of a workspace is a screen. It was a modal
until 0.6.0, and the complaint that moved it is the right one — at any window
size it read as a small box with a graph squeezed into it, and no amount of
arguing with the modal's own arithmetic was going to change what it was.

Drag the background to pan, scroll to zoom, double-click (or the button) to fit
the whole graph back into the pane. Click a dot to open the note, or tab to it
and press Enter. Drag a dot and the rest of the graph moves out of its way;
let go and it stays where you put it. Click a type in the legend to hide it.

The pane fills what it is given. The stats line, the controls and the legend
are rows at their natural height and the canvas takes everything left over —
a flex column, with no arithmetic anywhere that guesses at how tall Core's
chrome is. Such a guess is a number that is wrong the next time a toolbar
moves, and it is exactly what the modal version was full of. Resizing the
window resizes the canvas under it, so the view is re-framed to the new size at
the same scale: a wider window shows **more** graph rather than a bigger copy
of the same graph, which is what a map should do.

The sidebar **Graph** button and the command *Graph: map the workspace* take
you to that same pane — the nav entry, the button and the command are three
doors into one screen. On a host with no place to put a view at all the graph
opens in a modal instead; see *Surfaces* below.

## How it works, and where it will hurt

- One read of every object plus **one** read of the whole content index, rather
  than one index call per note — that would be hundreds of round trips on
  Core's single mutex-guarded connection.
- Wikilinks resolve by title, trimmed and case-insensitive. Two notes with the
  same title mean one of them wins: the lowest id, so the picture is at least
  the same on both your machines. Links to a note that does not exist are
  dropped rather than drawn to nowhere.
- The **starting** layout is seeded from the note ids, never `Math.random()`,
  and runs a fixed number of iterations. A graph that redraws differently on
  every open is not a map of anything. The live simulation continues from that
  picture; it never replaces it, so opening the graph twice on the same
  workspace still shows the same shape twice.
- **Capped at 1500 objects.** Past that it is a hairball whatever the layout
  does, and the repulsion step is O(n²). Above the cap it says so instead of
  quietly drawing a partial workspace.
- Titles are untrusted text — they arrive by sync and import — so everything is
  built as nodes with `textContent`, and the self-check greps the source for
  the markup-assigning properties.
- An object can opt out of the graph entirely by setting
  `props.$.graphExclude = true`. `$` is the reserved namespace inside `props`
  already used for cross-plugin signalling (`props.$._projectCalendarEvents`
  is the existing example); `graphExclude` is a second, deliberately generic
  entry in it, not a `type === "habit"` special case hardcoded here. It exists
  because a utility object — a habit, or whatever the next plugin invents — is
  not a note, and drawing it as a dot "filed under nothing" tells the user
  something false about their workspace: that it is an orphaned note, when it
  is not a note at all.

## Dots, the labels, and the lens

**0.11.0 replaced the cards with dots.** On a real workspace the 152×56 title
cards overlapped into a cloud of labels and buried the edges — the thing a
graph exists to show. A node is now a circle:

- **radius from degree** — the more links a note has, the bigger its dot,
  flattened and clamped so a hub reads as a landmark rather than a planet next
  to specks; and a **structural type** (project, milestone, chapter, act,
  space, folder, cycle, release) starts a size larger, because those are what
  the eye navigates by.
- **fill from type** — the whole dot is its type's hue now, not a thin stripe;
  a dot is small enough to just *be* the colour. A note **filed under nothing**
  is a hollow dashed ring instead of a fill, so "unfiled" reads without relying
  on the hue.

The title is drawn beside every dot but **shown only** for the dots that carry
the structure — degree ≥ 3, or a structural type — and for whatever the pointer
or the lens is on. Everything else is a bare dot. Showing every label at once
is the wall of text the cards were.

Hues still come from a fixed palette of sixteen, sorted and slot-probed so two
types on one canvas never share one while a slot is free, deterministic on the
*set* of types present. **Colour is never the only carrier:** the free ring is
independent of hue, the legend names every type, and the hover title states the
type and the container the dot sits in — which is what a screen reader reads
anyway.

Edges leave a dot on its circumference, so a line touches the dot rather than
vanishing under it. Edges rest **faint** — a link at 28% opacity, containment
and suggested fainter still — and come up to full only under the lens, because
at full strength a few hundred lines are the hairball. The layout ends with an
uncooled radial separation pass; overlap is not a preference to trade against
the springs.

Hovering or focusing a dot fades everything it has no edge to (unrelated dots
to 10%, their edges to 4%) and brings its own neighbours, their edges and their
labels up to full. Bound to hover rather than click because click already opens
the note.

**The toolbar filters, it never moves anything.** One strip above the canvas:

- **edge kinds** — links / inside / suggested, each an outlined rounded-rect
  toggle (a real `<input type="checkbox">` under the paint);
- **views** — *crossing only* keeps just the stored links whose two ends live
  under different containers (the sidebar-tree blind spot, and the reason this
  plugin exists); *unfiled only* keeps just the notes filed under nothing;
- **Fit to window**, and **Totals** as a small popover of the counts.

The legend's type chips are filters too: click one to drop that type and its
edges, click again to bring them back. None of it moves a dot or nudges the
simulation — the controls only change what is drawn over positions that come
from the layout and the user's own hands.

## Physics, and what it costs

The graph is live. The one-shot spring layout is still there and still pure,
deterministic and covered by the self-check — it is what produces the picture
the graph opens on. A `requestAnimationFrame` loop then continues from it with
the cooling schedule swapped for velocity damping, so the graph reacts to being
touched and comes back to rest instead of stopping mid-motion at iteration 260.

**Press and move a dot and it is a drag; press and release without moving and
it is a click that opens the note.** The threshold is four client pixels: small
enough that dragging feels immediate, large enough that a click with an unsteady
hand still opens the note. The click the browser fires at the end of a drag is
swallowed, and the flag that does the swallowing is cleared on the next press,
so it can never eat a later genuine click. Enter and Space on a focused dot are
untouched.

**A released dot stays pinned**, deliberately. You moved it there on purpose;
a dot that springs back the instant you let go makes the drag pointless, and
pinning is what lets someone pull one cluster clear of the rest and read it.
Pinned dots are outlined in the accent colour so the state is visible rather
than silent, and reopening the graph starts from the deterministic layout again
— there is nothing to undo and nothing stored.

Retuned for dots (measured on a dense random fixture, per the standing rule
that the self-check passes with wrong physics constants): repulsion 1600 with
the live loop's 0.88 damping settles a 40-node graph in about 250 frames and a
150-node one in about 550, overlap-free at every size in the live range. It
opens compact from the cooled layout and eases outward to a slightly airier
resting shape; "fit to window" reframes it.

The force model is O(n²) per tick, and a frame is 16.7ms. **Live physics is
capped at 400 nodes** — above it the graph is drawn from the settled layout,
dragging still moves one node at a time, and the UI says so. It parks itself
once the mean displacement per node falls below a threshold for twelve
consecutive frames, and wakes on the next interaction: a 60fps O(n²) loop that
never ends is a battery bug. And `prefers-reduced-motion` skips it entirely.

## Suggested edges

A third kind of edge, next to containment and stored `[[wikilinks]]`: pairs
nobody linked, derived from what they have in common. Two rules hold it together.

**A suggestion never outranks a fact.** Derived scores are capped below the
range stored edges occupy, and a pair that already has a real edge is not
derived a second time — a fact is never drawn twice, once as itself and once as
a weaker guess. Visually they are dashed, thinner and faded, because a guess
that looks like a fact is worse than no guess.

**Every suggested edge says why.** Hover one and it names the shared tags or
words, and states plainly that it is suggested rather than stored. An edge whose
reason cannot be read cannot be challenged, and the whole layer is only worth
having if it can be.

**No stopword list.** Terms are weighted by document frequency instead:
anything on more than a quarter of the objects is the workspace's own
vocabulary, not a connection between any two of its objects, and goes to zero.
The design prototype this grew out of used a hand-written list, which was
inevitably tuned to whatever workspace was in front of its author — it suppressed
"feedback", the one word that grouped four objects with no shared parent and no
link between them, which is precisely the case this layer exists for. Document
frequency is computed from the data and needs no tuning.

**Two signals only: shared tags and shared title words.** Same-type,
same-status and near-in-time were all tried against a real workspace and cut.
"open" and "task" are true of half the objects. Timestamps are worse than
useless: bulk edits leave whole groups of objects with `updated_at` milliseconds
apart, and a date layer presents that as a discovery. The self-check fails if
any of the three reappears.

Top-k is 8 per object, so one heavily tagged object cannot wire itself to
everything and leave the threshold as the only usable control.

## Known, and deliberately not fixed for alpha

- The layout keeps dots from overlapping across the whole live range (checked
  at 40, 67, 100, 200 and 400 objects), and the live loop settles overlap-free
  too. Above 400 the physics is off and the check does not claim it.
- Renaming a note does not rewrite `[[links]]` that point at its old title.
- Tags are read from `props.tags`, and in a workspace where only tasks carry
  tags that layer is empty for everything else. That is a fact about the data,
  not a bug here — the shared-word signal is what carries the layer today.
- Filtering is by edge kind, by type (from the legend), and by two views —
  crossing links, and unfiled notes. No tag or date filter, and no zoom-driven
  label threshold yet — the label rule is degree plus structural type.
- Explicit relations (`data.relations`) are not drawn — only `[[wikilinks]]`.
  Reading them means one call per object, which the API has no bulk form for.
- Clicking a dot opens the note in Core, rather than a preview panel inside the
  graph — a preview is on the list, it is just not this version.
- Pinned dots are not remembered between opens, and there is no way to unpin
  one short of reopening the graph. Both are deliberate for alpha: storing
  positions needs a write permission this plugin does not have and does not
  want.

## Surfaces

Registers a view — `id: "surface"`, title **Graph** — through
`views.register`, with a `mount`. `CoreOnlyApp` reads registered views off the
extension-host snapshot, gives each one a nav entry beside Notes and opens it
as a full-width pane. A registration without a `mount` gets the nav entry and a
pane saying the view registered no mount, so the mount is the whole contract.
This README said the opposite until 0.6.0, and it was right when it was
written: the pane had nowhere to draw. It has one now.

The pane is a flex column with 18px of padding that already draws its own
border, background and radius, so the plugin's root stretches into it and
paints none of the three. A card inside a card is the tell of a plugin that
thinks it is still a dialog.

Also uses `workspace.sidebar` and `ui.modal`. **The sidebar button and the
command open the pane**, through `ui.openView("surface")` — added in API 1.8,
which is why this plugin declares 1.8 and not 1.7. The call resolves against
this plugin's own registrations, so it can only ever open the graph's own
screen; there is no argument for naming somebody else's.

**The modal is the fallback, and it is still real.** `openView` resolves
`false` on a host that has nowhere to render a view — the Test Host, or any
embedding that renders slots and nothing else — and on one of those the graph
still has to open somewhere, so it opens in a dialog. Both entry points go
through one helper, `showGraph`, so that fallback is written once: a second
copy would rot, because it is the branch no developer's machine takes. The
pane and the modal are the same builder with one line of difference, which is
what makes keeping the fallback cheap.

A rejected `openView` is a different thing and is treated as one. It rejects
for a view id this plugin never registered — a typo, a programming error — not
for a host that cannot show views, so it surfaces as a notice rather than
quietly opening the modal. A fallback that hides a bug behind a window that
looks fine is how a nav entry ends up never being used.

Until 0.7.0 both entry points opened the modal, and this section said Core
offered no way to do otherwise. That was true when it was written; it is not
any more.

Whatever mounts it returns a `Disposable`, and it is doing real work. Core
disposes on navigate-away, disable, reload and uninstall; the graph runs a
`requestAnimationFrame` loop with an O(n²) tick in it, holds a `ResizeObserver`
and, mid-drag, three listeners on `window`. None of those live in the subtree
Core clears. A disposer that misses the frame leaves an invisible simulation
burning a core for as long as the app is open, so the self-check reads the
disposer's body and fails if any of the three is missing from it.

## Permissions

| Permission | Why |
|---|---|
| `data.read` | read the objects and the content index |
| `workspace.ui` | the registered view, opening it, the sidebar button and the fallback modal |

## Check

```
node plugins/notible-graph/self-check.mjs
```

Covers the surfaces — that a view is registered with a `mount`, that the
sidebar button and the command both reach it through one `ui.openView` helper
whose `false` branch is the modal and whose rejection is a notice, that the
manifest declares the 1.8 that call needs, and that the disposer cancels the
animation frame, disconnects the resize observer and ends a drag in flight, in
that order — plus wikilink resolution against malformed
and hostile input, title
collisions resolving the same way twice, parent cycles terminating, what counts
as a crossing link, and a layout that is finite, deterministic and survives two
notes landing on the same point. Since 0.5.0 it also covers the type→hue
mapping (deterministic, in range, order-independent, and separated enough to
read on a small dot), the live simulation (finite, settles, never moves a
pinned node), and the fact that the picture the graph opens on is still
identical across two calls.

## Install

In Notible: **Settings -> Plugins -> Market**, then install "Notible Graph".
This repo is the source; the market pulls `plugin.json` + `notible.graph.zip` from the latest GitHub Release.
