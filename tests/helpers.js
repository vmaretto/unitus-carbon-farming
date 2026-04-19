class FakeBlogPool {
  constructor() {
    this.posts = [];
    this.columns = new Set([
      'id',
      'title',
      'slug',
      'excerpt',
      'content',
      'cover_image_url',
      'published_at',
      'is_published',
      'created_at',
      'updated_at',
      'author',
      'source_module',
      'cover_image_prompt',
      'sources',
      'tags'
    ]);
  }

  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();

    if (normalized.includes('FROM information_schema.columns')) {
      return {
        rows: Array.from(this.columns).map((column_name) => ({ column_name }))
      };
    }

    if (normalized.startsWith('INSERT INTO blog_posts')) {
      const columnMatch = normalized.match(/INSERT INTO blog_posts \(([^)]+)\)/i);
      const columns = columnMatch[1].split(',').map((item) => item.trim());
      const row = {};
      columns.forEach((column, index) => {
        let value = params[index];
        if ((column === 'sources' || column === 'tags') && typeof value === 'string') {
          value = JSON.parse(value);
        }
        row[column] = value;
      });
      row.created_at = row.created_at || new Date().toISOString();
      row.updated_at = row.updated_at || new Date().toISOString();
      this.posts.push(row);
      return { rows: [{ ...row }] };
    }

    if (/^SELECT \* FROM blog_posts WHERE id = \$1 LIMIT 1$/i.test(normalized)) {
      const row = this.posts.find((post) => post.id === params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (normalized.startsWith('SELECT * FROM blog_posts')) {
      let rows = [...this.posts];
      if (normalized.includes('WHERE is_published = $1')) {
        rows = rows.filter((post) => Boolean(post.is_published) === Boolean(params[0]));
      }
      rows.sort((a, b) => {
        const left = a.published_at ? new Date(a.published_at).getTime() : 0;
        const right = b.published_at ? new Date(b.published_at).getTime() : 0;
        return right - left;
      });
      return { rows: rows.map((row) => ({ ...row })) };
    }

    if (normalized.startsWith('UPDATE blog_posts SET')) {
      const whereMatch = normalized.match(/WHERE id = \$(\d+)/i);
      const id = whereMatch ? params[Number(whereMatch[1]) - 1] : params[params.length - 1];
      const row = this.posts.find((post) => post.id === id);
      if (!row) return { rows: [] };

      const setPart = normalized.split(' WHERE ')[0].replace('UPDATE blog_posts SET ', '');
      const assignments = setPart.split(',').map((item) => item.trim()).filter((item) => item !== 'updated_at = NOW()');
      assignments.forEach((assignment) => {
        const match = assignment.match(/^([a-z_]+) = \$(\d+)$/i);
        if (!match) return;
        const column = match[1];
        let value = params[Number(match[2]) - 1];
        if ((column === 'sources' || column === 'tags') && typeof value === 'string') {
          value = JSON.parse(value);
        }
        row[column] = value;
      });
      row.updated_at = new Date().toISOString();
      return { rows: [{ ...row }] };
    }

    if (/^DELETE FROM blog_posts WHERE id = \$1$/i.test(normalized)) {
      const index = this.posts.findIndex((post) => post.id === params[0]);
      if (index === -1) return { rowCount: 0 };
      this.posts.splice(index, 1);
      return { rowCount: 1 };
    }

    throw new Error(`Unsupported query in FakeBlogPool: ${normalized}`);
  }
}

function tinyPngBase64() {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn0Wf8AAAAASUVORK5CYII=';
}

module.exports = {
  FakeBlogPool,
  tinyPngBase64
};
