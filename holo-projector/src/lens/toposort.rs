//! Port of the npm `toposort` package's `toposort.array(nodes, edges)`,
//! which the JS engine uses to order lenses by their `before`/`after`
//! constraints (`Workspace.getLenses` / `Branch.getLenses`).
//!
//! Lens execution order can change the final output tree (later lens output
//! merges over earlier), so the Rust engine must reproduce the oracle's
//! ordering exactly — including for unconstrained nodes. The npm package's
//! algorithm: iterate nodes from **last to first**, depth-first over each
//! node's outgoing edges in **reverse insertion order**, filling the result
//! array from the back. Unconstrained nodes therefore keep their input
//! order; constrained subgraphs get a DFS post-order that this port copies
//! rather than approximates (a stable Kahn's algorithm agrees on simple
//! graphs but can diverge on dense ones).

use std::collections::{BTreeMap, BTreeSet};

use crate::error::{Error, Result};

/// Topologically sort `nodes` (by index) so that for every edge `(a, b)`,
/// `a` appears before `b`. Node values are compared as strings; edges must
/// reference values present in `nodes`.
pub fn toposort(nodes: &[String], edges: &[(String, String)]) -> Result<Vec<String>> {
    // node value → index (last occurrence wins, as upstream)
    let mut node_index: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, node) in nodes.iter().enumerate() {
        node_index.insert(node.as_str(), i);
    }

    for (from, to) in edges {
        if !node_index.contains_key(from.as_str()) || !node_index.contains_key(to.as_str()) {
            return Err(Error::Other(format!(
                "lens ordering references unknown lens: {from} -> {to}"
            )));
        }
    }

    // node value → outgoing targets, deduped, in edge insertion order
    let mut outgoing: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut seen_edges: BTreeSet<(&str, &str)> = BTreeSet::new();
    for (from, to) in edges {
        if seen_edges.insert((from.as_str(), to.as_str())) {
            outgoing.entry(from.as_str()).or_default().push(to.as_str());
        }
    }

    let n = nodes.len();
    let mut walk = Walk {
        nodes,
        node_index: &node_index,
        outgoing: &outgoing,
        visited: vec![false; n],
        sorted: vec![None; n],
        cursor: n,
        predecessors: Vec::new(),
    };

    for i in (0..n).rev() {
        if !walk.visited[i] {
            walk.visit(nodes[i].as_str(), i)?;
        }
    }

    Ok(walk
        .sorted
        .into_iter()
        .map(|s| s.expect("every slot is filled by a visit"))
        .collect())
}

struct Walk<'a> {
    nodes: &'a [String],
    node_index: &'a BTreeMap<&'a str, usize>,
    outgoing: &'a BTreeMap<&'a str, Vec<&'a str>>,
    visited: Vec<bool>,
    sorted: Vec<Option<String>>,
    cursor: usize,
    predecessors: Vec<&'a str>,
}

impl<'a> Walk<'a> {
    fn visit(&mut self, node: &'a str, index: usize) -> Result<()> {
        if self.predecessors.contains(&node) {
            return Err(Error::CircularDependency {
                kind: "lens".to_string(),
            });
        }
        if self.visited[index] {
            return Ok(());
        }
        self.visited[index] = true;

        // Upstream walks the outgoing set from last to first.
        let targets = self.outgoing.get(node).cloned().unwrap_or_default();
        if !targets.is_empty() {
            self.predecessors.push(node);
            for &child in targets.iter().rev() {
                let child_index = *self
                    .node_index
                    .get(child)
                    .ok_or_else(|| Error::Other(format!("unknown lens in ordering: {child}")))?;
                self.visit(child, child_index)?;
            }
            self.predecessors.pop();
        }

        self.cursor -= 1;
        self.sorted[self.cursor] = Some(self.nodes[index].clone());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn e(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn unconstrained_preserves_order() {
        assert_eq!(
            toposort(&s(&["a", "b", "c"]), &[]).unwrap(),
            s(&["a", "b", "c"])
        );
    }

    #[test]
    fn simple_edge_respected() {
        // matches npm toposort.array(['a','b','c'], [['b','a']]) → ['b','a','c']
        assert_eq!(
            toposort(&s(&["a", "b", "c"]), &e(&[("b", "a")])).unwrap(),
            s(&["b", "a", "c"])
        );
        assert_eq!(
            toposort(&s(&["a", "b", "c"]), &e(&[("a", "b")])).unwrap(),
            s(&["a", "b", "c"])
        );
    }

    #[test]
    fn chain_via_wildcard_style_edges() {
        // c after everything: edges (a,c), (b,c)
        assert_eq!(
            toposort(&s(&["c", "a", "b"]), &e(&[("a", "c"), ("b", "c")])).unwrap(),
            s(&["a", "b", "c"])
        );
    }

    #[test]
    fn cycle_detected() {
        let err = toposort(&s(&["a", "b"]), &e(&[("a", "b"), ("b", "a")])).unwrap_err();
        assert_eq!(err.code(), "CIRCULAR_DEPENDENCY");
    }

    #[test]
    fn unknown_edge_node_errors() {
        assert!(toposort(&s(&["a"]), &e(&[("a", "zz")])).is_err());
    }
}
