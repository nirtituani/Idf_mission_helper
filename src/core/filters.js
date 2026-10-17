// Post/role filter shared by the search and the weekly board (also served to the browser).
// Option ids come from buildPostOptions and are scoped to one parsed roster.

export function resolvePostFilter(options, postId) {
  if (postId === 'all' || postId === undefined || postId === null) return { all: true, label: null };
  for (const g of options) {
    if (g.id === postId) return { sectionKey: g.sectionKey, positionKey: null, label: g.label };
    for (const p of g.positions) {
      if (p.id === postId) return { sectionKey: g.sectionKey, positionKey: p.positionKey, label: `${g.label ?? ''} / ${p.label}` };
    }
  }
  return null;
}

// x: anything with sectionKey/positionKey (assignment, empty slot, board row).
export function matchesFilter(filter, x) {
  return filter.all || (x.sectionKey === filter.sectionKey && (filter.positionKey === null || x.positionKey === filter.positionKey));
}
