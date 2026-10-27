/** Reads comma- or semicolon-separated text with quoted fields, keeping at most `limit` rows. */
export function parseCsv(value: string, limit = Infinity) {
  const text = value.replace(/^\uFEFF/, '');
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const separator =
    (firstLine.match(/;/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    total = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') {
      total++;
      if (rows.length < limit) rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += char;
  }
  if (field !== '' || row.length) endRow();
  return { rows, total };
}
