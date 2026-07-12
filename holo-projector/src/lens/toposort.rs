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
    let mut sorted: Vec<Option<String>> = vec![None; n];
    let mut cursor = n;
    let mut visited = vec![false; n];

    fn visit<'a>(
        node: &'a str,
        index: usize,
        predecessors: &mut Vec<&'a str>,
        nodes: &'a [String],
        node_index: &BTreeMap<&'a str, usize>,
        outgoing: &BTreeMap<&'a str, Vec<&'a str>>,
        visited: &mut [bool],
        sorted: &mut [Option<String>],
        cursor: &mut usize,
    ) -> Result<()> {
        if predecessors.contains(&node) {
            return Err(Error::CircularDependency {
                kind: "lens".to_string(),
            });
        }
        if visited[index] {
            return Ok(());
        }
        visited[index] = true;

        // Upstream walks the outgoing set from last to first.
        let targets = outgoing.get(node).cloned().unwrap_or_default();
        if !targets.is_empty() {
            predecessors.push(node);
            for &child in targets.iter().rev() {
                let child_index = *node_index
                    .get(child)
                    .ok_or_else(|| Error::Other(format!("unknown lens in ordering: {child}")))?;
                visit(
                    child,
                    child_index,
                    predecessors,
                    nodes,
                    node_index,
                    outgoing,
                    visited,
                    sorted,
                    cursor,
                )?;
            }
            predecessors.pop();
        }

        *cursor -= 1;
        sorted[*cursor] = Some(nodes[index].clone());
        Ok(())
    }

    let mut predecessors: Vec<&str> = Vec::new();
    for i in (0..n).rev() {
        if !visited[i] {
            visit(
                nodes[i].as_str(),
                i,
                &mut predecessors,
                nodes,
                &node_index,
                &outgoing,
                &mut visited,
                &mut sorted,
                &mut cursor,
            )?;
        }
    }

    Ok(sorted.into_iter().map(|s| s.expect("filled")).collect())
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
