/**
 * A JSON object column, as an object.
 *
 * Everything stored as JSON in this database is read through here: a column
 * that is malformed, null, or holds an array or a scalar reads as an empty
 * object rather than throwing, because a single unparseable row must not stop
 * a sweep that is walking a thousand of them.
 */
export const parseObject = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};
