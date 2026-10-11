export const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );

export const basename = (path: string) => path.split('/').pop() || path;
export const ext = (path: string) => path.split('.').pop()?.toLowerCase() || '';
