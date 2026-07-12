//! Byte-faithful port of `@iarna/toml`'s `stringify` for lens spec objects.
//!
//! Lens spec hashing (`specs/behaviors/lensing.md` § Spec and content
//! addressing) is keyed on the git blob hash of the serialized spec TOML, so
//! the Rust engine must produce **byte-identical** output to the JS engine's
//! `SpecObject.write` (`TOML.stringify` from `@iarna/toml@2`, applied to a
//! deep-key-sorted object). This module ports that serializer's observable
//! behavior exactly — including its quirks — for the value domain reachable
//! from parsed lens config TOML:
//!
//! - section headers indented two spaces per nesting level, preceded by a
//!   blank line, and **omitted entirely** for tables with no scalar entries;
//! - inline arrays wrapped to one-per-line when the joined form exceeds 60
//!   characters;
//! - integral floats emitted as integers, and integers digit-grouped with
//!   underscores (`1000` → `1_000`);
//! - strings preferring literal (single-quoted) form when they contain a
//!   double quote but no control characters or single quotes, and multiline
//!   basic form when they contain newlines;
//! - only the **first** unhandled control character `\u`-escaped (an upstream
//!   bug, ported faithfully — such strings cannot round-trip through TOML
//!   parsing anyway, so this is unreachable from real configs).
//!
//! Key order is the serialized order: callers pass `toml::Table`, whose
//! default (non-`preserve_order`) backing is a `BTreeMap`, giving the same
//! byte-order sort as the JS engine's `deepSortKeys` for ASCII keys. (The JS
//! sort compares UTF-16 code units; divergence is only possible for keys
//! containing non-ASCII characters, which no real lens config has.)
//!
//! Datetime values are rejected: the JS pipeline's `deepSortKeys` degrades
//! `Date` objects to empty tables before stringifying, but a datetime in a
//! lens config is meaningless and better surfaced as an error than silently
//! hashed as `{ }`.

use toml::Value;

use crate::error::{Error, Result};

/// Serialize a spec table exactly as the JS engine's
/// `TOML.stringify({ holospec: { <kind>: data } })` would.
///
/// The caller passes the *full* document table (i.e. including the
/// `holospec` wrapper), pre-sorted by virtue of `toml::Table`'s BTreeMap
/// backing.
pub fn stringify(table: &toml::Table) -> Result<String> {
    stringify_object("", "", table)
}

fn type_error(kind: &str) -> Error {
    Error::Other(format!("cannot stringify {kind} in lens spec"))
}

/// The serializer's view of a value's TOML type (`tomlType` upstream).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TomlType {
    Integer,
    Float,
    Boolean,
    String,
    Array,
    Table,
    Datetime,
}

fn toml_type(value: &Value) -> TomlType {
    match value {
        // JS: Number.isInteger(v) && !Object.is(v, -0) → integer. TOML
        // distinguishes integers from floats at parse time, but a float that
        // parses to an integral JS number (`2.0`) is emitted as an integer.
        Value::Integer(_) => TomlType::Integer,
        Value::Float(f) => {
            if f.fract() == 0.0
                && f.is_finite()
                && !(*f == 0.0 && f.is_sign_negative())
            {
                TomlType::Integer
            } else {
                TomlType::Float
            }
        }
        Value::Boolean(_) => TomlType::Boolean,
        Value::String(_) => TomlType::String,
        Value::Array(_) => TomlType::Array,
        Value::Table(_) => TomlType::Table,
        Value::Datetime(_) => TomlType::Datetime,
    }
}

/// `isInline` upstream: scalars and homogeneous-primitive arrays render on
/// the key's own line; tables (and arrays of tables) become sections.
fn is_inline(value: &Value) -> Result<bool> {
    Ok(match toml_type(value) {
        TomlType::Integer | TomlType::Float | TomlType::Boolean | TomlType::String => true,
        TomlType::Datetime => return Err(type_error("datetime")),
        TomlType::Array => {
            let arr = value.as_array().expect("checked array");
            arr.is_empty() || toml_type(&arr[0]) != TomlType::Table
        }
        TomlType::Table => value.as_table().expect("checked table").is_empty(),
    })
}

fn stringify_object(prefix: &str, indent: &str, table: &toml::Table) -> Result<String> {
    let mut inline_keys = Vec::new();
    let mut complex_keys = Vec::new();
    for (key, value) in table {
        if is_inline(value)? {
            inline_keys.push(key);
        } else {
            complex_keys.push(key);
        }
    }

    let mut result: Vec<String> = Vec::new();
    for key in &inline_keys {
        let value = &table[key.as_str()];
        result.push(format!(
            "{indent}{} = {}",
            stringify_key(key),
            stringify_any_inline(value, true)?
        ));
    }
    if !result.is_empty() {
        result.push(String::new());
    }

    // Upstream: complex children indent only when this table is itself
    // nested (`prefix` non-empty) *and* it rendered scalar entries.
    let complex_indent = if !prefix.is_empty() && !inline_keys.is_empty() {
        format!("{indent}  ")
    } else {
        String::new()
    };

    for key in &complex_keys {
        let value = &table[key.as_str()];
        result.push(stringify_complex(prefix, &complex_indent, key, value)?);
    }

    Ok(result.join("\n"))
}

fn stringify_complex(prefix: &str, indent: &str, key: &str, value: &Value) -> Result<String> {
    match value {
        Value::Array(values) => stringify_array_of_tables(prefix, indent, key, values),
        Value::Table(table) => stringify_complex_table(prefix, indent, key, table),
        _ => Err(type_error("value")),
    }
}

fn stringify_array_of_tables(
    prefix: &str,
    indent: &str,
    key: &str,
    values: &[Value],
) -> Result<String> {
    validate_array(values)?;
    let full_key = format!("{prefix}{}", stringify_key(key));
    let mut result = String::new();
    for value in values {
        let table = value
            .as_table()
            .ok_or_else(|| Error::Other("array of tables contains a non-table".into()))?;
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(&format!("{indent}[[{full_key}]]\n"));
        result.push_str(&stringify_object(&format!("{full_key}."), indent, table)?);
    }
    Ok(result)
}

fn stringify_complex_table(
    prefix: &str,
    indent: &str,
    key: &str,
    table: &toml::Table,
) -> Result<String> {
    let full_key = format!("{prefix}{}", stringify_key(key));
    let mut result = String::new();
    // Upstream quirk: the section header appears only when the table has at
    // least one inline (scalar) entry; a table of nothing but sub-tables is
    // reached purely through its children's headers.
    let mut has_inline = false;
    for value in table.values() {
        if is_inline(value)? {
            has_inline = true;
            break;
        }
    }
    if has_inline {
        result.push_str(&format!("{indent}[{full_key}]\n"));
    }
    result.push_str(&stringify_object(&format!("{full_key}."), indent, table)?);
    Ok(result)
}

// ── Keys ───────────────────────────────────────────────────────────────────

fn stringify_key(key: &str) -> String {
    if !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        key.to_string()
    } else {
        stringify_basic_string(key)
    }
}

// ── Inline values ──────────────────────────────────────────────────────────

fn stringify_any_inline(value: &Value, multiline_ok: bool) -> Result<String> {
    if let Value::String(s) = value {
        if multiline_ok && s.contains('\n') {
            return Ok(stringify_multiline_string(s));
        }
        if !s.contains(['\u{8}', '\t', '\n', '\u{c}', '\r', '\'']) && s.contains('"') {
            return Ok(format!("'{s}'"));
        }
    }
    stringify_inline(value, toml_type(value))
}

fn stringify_inline(value: &Value, as_type: TomlType) -> Result<String> {
    Ok(match as_type {
        TomlType::String => match value {
            Value::String(s) => stringify_basic_string(s),
            _ => return Err(type_error("value")),
        },
        TomlType::Integer => match value {
            Value::Integer(i) => stringify_integer(&i.to_string()),
            Value::Float(f) => stringify_integer(&js_number_to_string(*f)),
            _ => return Err(type_error("value")),
        },
        TomlType::Float => match value {
            Value::Float(f) => stringify_float(*f),
            // Mixed numeric arrays force integers through the float path.
            Value::Integer(i) => stringify_float(*i as f64),
            _ => return Err(type_error("value")),
        },
        TomlType::Boolean => match value {
            Value::Boolean(b) => b.to_string(),
            _ => return Err(type_error("value")),
        },
        TomlType::Array => match value {
            Value::Array(values) => stringify_inline_array(values)?,
            _ => return Err(type_error("value")),
        },
        TomlType::Table => match value {
            Value::Table(table) => stringify_inline_table(table)?,
            _ => return Err(type_error("value")),
        },
        TomlType::Datetime => return Err(type_error("datetime")),
    })
}

fn stringify_inline_array(values: &[Value]) -> Result<String> {
    let element_type = validate_array(values)?;
    let mut stringified = Vec::with_capacity(values.len());
    for value in values {
        stringified.push(match element_type {
            Some(t) => stringify_inline(value, t)?,
            None => unreachable!("empty array has no elements"),
        });
    }
    let joined = stringified.join(", ");
    Ok(if joined.len() > 60 || joined.contains('\n') {
        format!("[\n  {}\n]", stringified.join(",\n  "))
    } else if stringified.is_empty() {
        "[ ]".to_string()
    } else {
        format!("[ {joined} ]")
    })
}

fn stringify_inline_table(table: &toml::Table) -> Result<String> {
    let mut entries = Vec::with_capacity(table.len());
    for (key, value) in table {
        entries.push(format!(
            "{} = {}",
            stringify_key(key),
            stringify_any_inline(value, false)?
        ));
    }
    Ok(if entries.is_empty() {
        "{ }".to_string()
    } else {
        format!("{{ {} }}", entries.join(", "))
    })
}

/// Upstream `arrayType`/`validateArray`: arrays must be single-typed, except
/// that mixed integer/float arrays are promoted to all-float. Returns the
/// element type to stringify with (`None` for empty arrays).
fn validate_array(values: &[Value]) -> Result<Option<TomlType>> {
    let Some(first) = values.first() else {
        return Ok(None);
    };
    let content_type = toml_type(first);
    if values.iter().all(|v| toml_type(v) == content_type) {
        return Ok(Some(content_type));
    }
    let numeric = |t: TomlType| t == TomlType::Integer || t == TomlType::Float;
    if values.iter().all(|v| numeric(toml_type(v))) {
        return Ok(Some(TomlType::Float));
    }
    Err(Error::Other(
        "Array values can't have mixed types".into(),
    ))
}

// ── Strings ────────────────────────────────────────────────────────────────

/// Upstream `escapeString`. Note the final control-character replacement is
/// deliberately **non-global** — only the first such character is escaped —
/// mirroring the upstream implementation.
fn escape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut control_escaped = false;
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if !control_escaped && (('\u{0}'..='\u{1f}').contains(&c) || c == '\u{7f}') => {
                out.push_str(&format!("\\u{:04x}", c as u32));
                control_escaped = true;
            }
            c => out.push(c),
        }
    }
    out
}

fn stringify_basic_string(s: &str) -> String {
    format!("\"{}\"", escape_string(s).replace('"', "\\\""))
}

fn stringify_multiline_string(s: &str) -> String {
    let escaped_lines: Vec<String> = s
        .split('\n')
        .map(|line| escape_quote_before_double(&escape_string(line)))
        .collect();
    let mut escaped = escaped_lines.join("\n");
    if escaped.ends_with('"') {
        escaped.push_str("\\\n");
    }
    format!("\"\"\"\n{escaped}\"\"\"")
}

/// Upstream `.replace(/"(?="")/g, '\\"')`: escape a quote only when followed
/// by two more quotes; the lookahead is not consumed, so runs of quotes are
/// processed with single-character advance.
fn escape_quote_before_double(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '"'
            && i + 2 < chars.len()
            && chars[i + 1] == '"'
            && chars[i + 2] == '"'
        {
            out.push_str("\\\"");
        } else {
            out.push(chars[i]);
        }
        i += 1;
    }
    out
}

// ── Numbers ────────────────────────────────────────────────────────────────

/// Upstream `stringifyInteger`: digit-group with underscores
/// (`/\B(?=(\d{3})+(?!\d))/g`).
fn stringify_integer(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && is_word(chars[i - 1]) && is_word(c) {
            // \B position — does (\d{3})+(?!\d) match here?
            let run = chars[i..].iter().take_while(|c| c.is_ascii_digit()).count();
            if run > 0 && run % 3 == 0 {
                out.push('_');
            }
        }
        out.push(c);
    }
    out
}

/// Upstream `stringifyFloat`, including its quirky `int + "." + dec` re-join.
fn stringify_float(f: f64) -> String {
    if f == f64::INFINITY {
        return "inf".to_string();
    }
    if f == f64::NEG_INFINITY {
        return "-inf".to_string();
    }
    if f.is_nan() {
        return "nan".to_string();
    }
    if f == 0.0 && f.is_sign_negative() {
        return "-0.0".to_string();
    }
    let s = js_number_to_string(f);
    let (int, dec) = match s.split_once('.') {
        Some((i, d)) => (i.to_string(), d.to_string()),
        None => (s, "0".to_string()),
    };
    format!("{}.{dec}", stringify_integer(&int))
}

/// Approximate ECMAScript `Number::toString` for the doubles reachable from
/// TOML configs: plain shortest-round-trip decimal within JS's non-exponent
/// range, exponent notation (`1e+30`, `1.5e-7`) outside it. Rust's shortest
/// formatting produces the same digits as V8 for round-trip values.
fn js_number_to_string(f: f64) -> String {
    let abs = f.abs();
    if f != 0.0 && (abs >= 1e21 || abs < 1e-6) {
        // format {:e} → "1.5e30" / "1e30" / "1.5e-7"; JS wants a '+' on
        // non-negative exponents.
        let s = format!("{f:e}");
        match s.split_once('e') {
            Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
            _ => s,
        }
    } else if f.fract() == 0.0 {
        format!("{f:.0}")
    } else {
        format!("{f}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize `data` as `{ holospec: { lens: data } }`, the shape specs
    /// are hashed in.
    fn spec(data: toml::Table) -> String {
        let mut lens_wrapper = toml::Table::new();
        lens_wrapper.insert("lens".into(), Value::Table(data));
        let mut doc = toml::Table::new();
        doc.insert("holospec".into(), Value::Table(lens_wrapper));
        stringify(&doc).unwrap()
    }

    fn table(pairs: &[(&str, Value)]) -> toml::Table {
        let mut t = toml::Table::new();
        for (k, v) in pairs {
            t.insert(k.to_string(), v.clone());
        }
        t
    }

    // Every expected string below was captured from the real JS pipeline:
    // `TOML.stringify({ holospec: { lens: deepSortKeys(data) } })` with
    // `@iarna/toml@2` (the exact library `lib/SpecObject.js` uses).

    #[test]
    fn basic_scalars() {
        let out = spec(table(&[
            ("container", Value::String("ghcr.io/x@sha256:abc".into())),
            ("input", Value::String("deadbeef".into())),
        ]));
        assert_eq!(
            out,
            "[holospec.lens]\ncontainer = \"ghcr.io/x@sha256:abc\"\ninput = \"deadbeef\"\n"
        );
    }

    #[test]
    fn nested_table_indents_and_blank_line() {
        let out = spec(table(&[
            ("container", Value::String("x".into())),
            ("input", Value::String("h".into())),
            (
                "mkdocs",
                Value::Table(table(&[(
                    "requirements",
                    Value::Array(vec![
                        Value::String("mkdocs-material".into()),
                        Value::String("mdx_truly_sane_lists".into()),
                    ]),
                )])),
            ),
        ]));
        assert_eq!(
            out,
            "[holospec.lens]\ncontainer = \"x\"\ninput = \"h\"\n\n  [holospec.lens.mkdocs]\n  requirements = [ \"mkdocs-material\", \"mdx_truly_sane_lists\" ]\n"
        );
    }

    #[test]
    fn long_array_wraps_per_line() {
        // The real docs-site mkdocs lens: joined length exceeds 60.
        let out = spec(table(&[(
            "requirements",
            Value::Array(vec![
                Value::String("mkdocs-material".into()),
                Value::String("mkdocs-awesome-pages-plugin".into()),
                Value::String("mdx_truly_sane_lists".into()),
            ]),
        )]));
        assert_eq!(
            out,
            "[holospec.lens]\nrequirements = [\n  \"mkdocs-material\",\n  \"mkdocs-awesome-pages-plugin\",\n  \"mdx_truly_sane_lists\"\n]\n"
        );
    }

    #[test]
    fn scalar_types_and_multiline_string() {
        let out = spec(table(&[
            (
                "arr",
                Value::Array(vec![Value::Integer(1), Value::Integer(2)]),
            ),
            ("b", Value::Boolean(true)),
            ("f", Value::Float(1.5)),
            ("i", Value::Integer(42)),
            ("s", Value::String("q\"uo\\te\nnl".into())),
        ]));
        assert_eq!(
            out,
            "[holospec.lens]\narr = [ 1, 2 ]\nb = true\nf = 1.5\ni = 42\ns = \"\"\"\nq\"uo\\\\te\nnl\"\"\"\n"
        );
    }

    #[test]
    fn empty_array() {
        let out = spec(table(&[
            ("arr", Value::Array(vec![])),
            ("container", Value::String("x".into())),
        ]));
        assert_eq!(out, "[holospec.lens]\narr = [ ]\ncontainer = \"x\"\n");
    }

    #[test]
    fn literal_string_for_embedded_quotes() {
        let out = spec(table(&[("s", Value::String("say \"hi\" there".into()))]));
        assert_eq!(out, "[holospec.lens]\ns = 'say \"hi\" there'\n");
    }

    #[test]
    fn backslash_uses_basic_string() {
        let out = spec(table(&[("s", Value::String("a\\b".into()))]));
        assert_eq!(out, "[holospec.lens]\ns = \"a\\\\b\"\n");
    }

    #[test]
    fn control_characters() {
        let out = spec(table(&[
            ("s", Value::String("tab\there".into())),
            ("t", Value::String("bell\u{7}x".into())),
            ("u", Value::String("unié☃".into())),
        ]));
        assert_eq!(
            out,
            "[holospec.lens]\ns = \"tab\\there\"\nt = \"bell\\u0007x\"\nu = \"unié☃\"\n"
        );
    }

    #[test]
    fn deep_nesting_indents_two_per_level() {
        let out = spec(table(&[
            (
                "a",
                Value::Table(table(&[
                    ("b", Value::Table(table(&[("c", Value::String("x".into()))]))),
                    ("k", Value::String("v".into())),
                ])),
            ),
            ("top", Value::Integer(1)),
        ]));
        assert_eq!(
            out,
            "[holospec.lens]\ntop = 1\n\n  [holospec.lens.a]\n  k = \"v\"\n\n    [holospec.lens.a.b]\n    c = \"x\"\n"
        );
    }

    #[test]
    fn array_of_tables() {
        let out = spec(table(&[
            (
                "arr",
                Value::Array(vec![
                    Value::Table(table(&[("n", Value::Integer(1))])),
                    Value::Table(table(&[("n", Value::Integer(2))])),
                ]),
            ),
            ("s", Value::String("x".into())),
        ]));
        assert_eq!(
            out,
            "[holospec.lens]\ns = \"x\"\n\n  [[holospec.lens.arr]]\n  n = 1\n\n  [[holospec.lens.arr]]\n  n = 2\n"
        );
    }

    #[test]
    fn nested_arrays_inline() {
        let out = spec(table(&[(
            "arr",
            Value::Array(vec![
                Value::Array(vec![Value::String("a".into())]),
                Value::Array(vec![Value::String("b".into())]),
            ]),
        )]));
        assert_eq!(out, "[holospec.lens]\narr = [ [ \"a\" ], [ \"b\" ] ]\n");
    }

    #[test]
    fn float_formats() {
        let out = spec(table(&[
            ("a", Value::Float(1.0)),
            ("b", Value::Float(-2.5)),
            ("c", Value::Float(1e30)),
            ("d", Value::Float(0.1)),
        ]));
        assert_eq!(
            out,
            "[holospec.lens]\na = 1\nb = -2.5\nc = 1e+30\nd = 0.1\n"
        );
    }

    #[test]
    fn integer_underscore_grouping() {
        let out = spec(table(&[
            ("a", Value::Integer(1000)),
            ("b", Value::Integer(-1000)),
            ("c", Value::Integer(600)),
            ("d", Value::Integer(1234567)),
        ]));
        assert_eq!(
            out,
            "[holospec.lens]\na = 1_000\nb = -1_000\nc = 600\nd = 1_234_567\n"
        );
    }

    #[test]
    fn quoted_keys() {
        let out = spec(table(&[
            ("weird.key", Value::Integer(1)),
            ("ok-key_2", Value::Integer(2)),
        ]));
        // BTreeMap byte order: '"' cases still sort by raw key.
        assert_eq!(
            out,
            "[holospec.lens]\nok-key_2 = 2\n\"weird.key\" = 1\n"
        );
    }

    #[test]
    fn empty_string_and_empty_table() {
        let out = spec(table(&[
            ("s", Value::String("".into())),
            ("t", Value::Table(toml::Table::new())),
        ]));
        assert_eq!(out, "[holospec.lens]\ns = \"\"\nt = { }\n");
    }

    #[test]
    fn crlf_multiline() {
        let out = spec(table(&[("s", Value::String("a\r\nb".into()))]));
        assert_eq!(out, "[holospec.lens]\ns = \"\"\"\na\\r\nb\"\"\"\n");
    }

    #[test]
    fn multiline_trailing_newline_and_quotes() {
        let ends_nl = spec(table(&[(
            "s",
            Value::String("ends with newline\n".into()),
        )]));
        assert_eq!(
            ends_nl,
            "[holospec.lens]\ns = \"\"\"\nends with newline\n\"\"\"\n"
        );

        let trip = spec(table(&[(
            "s",
            Value::String("has \"\"\" inside\nand newline".into()),
        )]));
        assert_eq!(
            trip,
            "[holospec.lens]\ns = \"\"\"\nhas \\\"\"\" inside\nand newline\"\"\"\n"
        );
    }

    #[test]
    fn table_with_only_subtables_gets_no_header() {
        let out = spec(table(&[(
            "atbl",
            Value::Table(table(&[("x", Value::Integer(1))])),
        )]));
        // holospec.lens has no scalar entries → its header is omitted and
        // the child section is not indented.
        assert_eq!(out, "[holospec.lens.atbl]\nx = 1\n");
    }

    #[test]
    fn toml_table_iterates_sorted() {
        // The serializer relies on toml::Table's BTreeMap backing for the
        // deepSortKeys equivalence; this guards against the crate's
        // `preserve_order` feature being enabled by a future dependency.
        let mut t = toml::Table::new();
        t.insert("zebra".into(), Value::Integer(1));
        t.insert("_resolved".into(), Value::Integer(2));
        t.insert("alpha".into(), Value::Integer(3));
        let keys: Vec<&String> = t.keys().collect();
        assert_eq!(keys, ["_resolved", "alpha", "zebra"]);
    }
}
