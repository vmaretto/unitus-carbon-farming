const mammoth = require('mammoth');
const cheerio = require('cheerio');

const ITALIAN_MONTHS = {
  gennaio: 0,
  febbraio: 1,
  marzo: 2,
  aprile: 3,
  maggio: 4,
  giugno: 5,
  luglio: 6,
  agosto: 7,
  settembre: 8,
  ottobre: 9,
  novembre: 10,
  dicembre: 11
};

function normalizeWhitespace(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(value = '') {
  return normalizeWhitespace(
    String(value)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
  );
}

function slugify(value = '') {
  return normalizeWhitespace(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function parseItalianDateToIso(rawValue, fallbackDate = new Date()) {
  const value = normalizeWhitespace(rawValue).toLowerCase();
  const match = value.match(/^(\d{1,2})\s+([a-zà]+)\s+(\d{4})$/i);
  if (!match) {
    return new Date(fallbackDate).toISOString();
  }

  const day = Number(match[1]);
  const monthName = match[2]
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const year = Number(match[3]);
  const month = ITALIAN_MONTHS[monthName];
  if (!Number.isInteger(day) || !Number.isInteger(year) || month === undefined) {
    return new Date(fallbackDate).toISOString();
  }

  const date = new Date(Date.UTC(year, month, day, 9, 0, 0));
  if (Number.isNaN(date.getTime())) {
    return new Date(fallbackDate).toISOString();
  }
  return date.toISOString();
}

function normalizeSectionHeading(text = '') {
  return normalizeWhitespace(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function detectSectionHeading(text = '') {
  const normalized = normalizeSectionHeading(text);
  if (!normalized) return null;
  if (/^abstract\b/.test(normalized)) return 'abstract';
  if (normalized.includes('corpo articolo')) return 'body';
  if (normalized.includes('media suggeriti') || normalized.includes('media consigliati')) return 'media';
  if (normalized.includes('fonti da linkare')) return 'sources';
  if (normalized.includes('metadati articolo')) return 'metadata';
  return null;
}

function extractLinesFromNode($, node) {
  if (!node) return [];
  const lines = [];

  if (node.name === 'table') {
    $(node).find('tr').each((_, row) => {
      const cellTexts = $(row).find('th, td').map((__, cell) => normalizeWhitespace($(cell).text())).get().filter(Boolean);
      if (!cellTexts.length) return;
      lines.push(cellTexts.join(' '));
    });
    return lines;
  }

  const html = $(node).html() || '';
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map((line) => stripHtml(line))
    .filter(Boolean)
    .forEach((line) => lines.push(line));

  if (!lines.length) {
    const text = normalizeWhitespace($(node).text());
    if (text) lines.push(text);
  }

  return lines;
}

function readKeyValueLines(lines = []) {
  const metadata = new Map();

  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    metadata.set(normalizeSectionHeading(match[1]), normalizeWhitespace(match[2]));
  }

  return metadata;
}

function findMetadataValue(metadata, keywords = []) {
  for (const [key, value] of metadata.entries()) {
    if (keywords.some((keyword) => key.includes(keyword))) {
      return value;
    }
  }
  return null;
}

function extractExcerpt($, nodes = []) {
  for (const node of nodes) {
    const emphasized = $(node).find('em, i').first();
    if (emphasized.length) {
      const text = normalizeWhitespace(emphasized.text());
      if (text) return text;
    }
  }

  for (const node of nodes) {
    const text = normalizeWhitespace($(node).text());
    if (text) return text;
  }

  return '';
}

function collectHtml($, nodes = []) {
  return nodes
    .map((node) => $.html(node) || '')
    .join('\n')
    .trim();
}

function dedupeSources(sources = []) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = `${source.title}::${source.url}`;
    if (!source.title || !source.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractSources($, nodes = []) {
  const sources = [];

  nodes.forEach((node) => {
    $(node).find('a[href]').each((_, link) => {
      const title = normalizeWhitespace($(link).text()) || normalizeWhitespace($(link).attr('href'));
      const url = normalizeWhitespace($(link).attr('href'));
      if (title && url) {
        sources.push({ title, url });
      }
    });
  });

  return dedupeSources(sources);
}

function extractMediaData($, nodes = []) {
  const media = {
    coverImageUrl: null,
    coverImagePrompt: null
  };

  let context = null;
  const lines = nodes.flatMap((node) => extractLinesFromNode($, node));

  for (const line of lines) {
    const normalized = normalizeWhitespace(line);
    if (!normalized) continue;

    if (/^immagine di copertina/i.test(normalized)) {
      context = 'cover';
      const match = normalized.match(/^immagine di copertina(?:\s*\(ai\))?\s*:\s*(.+)$/i);
      if (match && /^https?:\/\//i.test(match[1])) {
        media.coverImageUrl = match[1];
      }
      continue;
    }

    if (/^video embed/i.test(normalized)) {
      context = 'video';
      continue;
    }

    if (/^prompt ai:/i.test(normalized)) {
      media.coverImagePrompt = normalized.replace(/^prompt ai:\s*/i, '').trim();
      continue;
    }

    const arrowMatch = normalized.match(/^→\s*(https?:\/\/\S+)/i);
    if (arrowMatch && context === 'cover' && !media.coverImageUrl) {
      media.coverImageUrl = arrowMatch[1];
    }
  }

  return media;
}

function extractArticleBlocks($) {
  const bodyChildren = $('body').children().toArray().filter((node) => normalizeWhitespace($(node).text()));
  const markerIndexes = [];

  bodyChildren.forEach((node, index) => {
    const text = normalizeWhitespace($(node).text());
    if (/^articolo\s+\d+\s*\/\s*\d+$/i.test(text)) {
      markerIndexes.push(index);
    }
  });

  return markerIndexes.map((startIndex, blockIndex) => {
    const endIndex = markerIndexes[blockIndex + 1] ?? bodyChildren.length;
    return bodyChildren.slice(startIndex, endIndex);
  });
}

function buildArticleFromBlock($, nodes, index, fallbackDate = new Date()) {
  const warnings = [];
  const label = normalizeWhitespace($(nodes[0]).text()) || `ARTICOLO ${index + 1}`;
  const bodyNodes = nodes.slice(1);

  const titleIndex = bodyNodes.findIndex((node) => {
    const text = normalizeWhitespace($(node).text());
    if (!text) return false;
    if (detectSectionHeading(text)) return false;
    if (node.name === 'h1') return true;
    return false;
  });

  if (titleIndex === -1) {
    throw new Error(`Titolo mancante nell'articolo ${index + 1}`);
  }

  const title = normalizeWhitespace($(bodyNodes[titleIndex]).text());
  if (!title) {
    throw new Error(`Titolo mancante nell'articolo ${index + 1}`);
  }

  const sections = {
    metadata: [],
    abstract: [],
    body: [],
    media: [],
    sources: []
  };

  let currentSection = 'metadata';
  for (const node of bodyNodes.slice(titleIndex + 1)) {
    const section = detectSectionHeading($(node).text());
    if (section) {
      currentSection = section;
      continue;
    }
    sections[currentSection].push(node);
  }

  const metadataLines = sections.metadata.flatMap((node) => extractLinesFromNode($, node));
  const metadata = readKeyValueLines(metadataLines);
  const publicationDateRaw = findMetadataValue(metadata, ['data pubblicazione', 'pubblicazione']);
  const author = findMetadataValue(metadata, ['autore']) || 'Redazione Master Carbon Farming';
  const tagsRaw = findMetadataValue(metadata, ['tag']);
  const sourceModule = findMetadataValue(metadata, ['modulo del master collegato', 'modulo']);

  if (!tagsRaw) {
    warnings.push(`Campo Tag mancante nell'articolo ${index + 1}`);
  }

  if (!publicationDateRaw) {
    warnings.push(`Campo Data pubblicazione mancante nell'articolo ${index + 1}; uso la data odierna`);
  }

  const tags = tagsRaw
    ? tagsRaw
        .split(',')
        .map((tag) => normalizeWhitespace(tag))
        .filter(Boolean)
    : [];

  const excerpt = extractExcerpt($, sections.abstract);
  const content = collectHtml($, sections.body);
  if (!content) {
    throw new Error(`Corpo articolo mancante nell'articolo ${index + 1}`);
  }

  const media = extractMediaData($, sections.media);
  const sources = extractSources($, sections.sources);
  const slug = slugify(title);

  if (!slug) {
    throw new Error(`Impossibile generare lo slug per l'articolo ${index + 1}`);
  }

  return {
    label,
    title,
    slug,
    excerpt: excerpt || stripHtml(content).slice(0, 280),
    content,
    tags,
    author,
    sourceModule: sourceModule || null,
    publishedAt: parseItalianDateToIso(publicationDateRaw, fallbackDate),
    coverImageUrl: media.coverImageUrl || null,
    coverImagePrompt: media.coverImagePrompt || null,
    sources,
    published: false,
    warnings
  };
}

function parseBlogPostsFromHtml(html, options = {}) {
  const fallbackDate = options.now || new Date();
  const $ = cheerio.load(`<body>${html || ''}</body>`);
  const blocks = extractArticleBlocks($);

  if (!blocks.length) {
    throw new Error('Nessun blocco "ARTICOLO N/M" trovato nel file Word');
  }

  const posts = [];
  const warnings = [];

  blocks.forEach((block, index) => {
    const parsed = buildArticleFromBlock($, block, index, fallbackDate);
    posts.push({
      title: parsed.title,
      slug: parsed.slug,
      excerpt: parsed.excerpt,
      content: parsed.content,
      tags: parsed.tags,
      author: parsed.author,
      sourceModule: parsed.sourceModule,
      publishedAt: parsed.publishedAt,
      coverImageUrl: parsed.coverImageUrl,
      coverImagePrompt: parsed.coverImagePrompt,
      sources: parsed.sources,
      published: false
    });
    warnings.push(...parsed.warnings);
  });

  return { posts, warnings };
}

async function parseBlogPostsFromDocxBuffer(buffer, options = {}) {
  const result = await mammoth.convertToHtml({ buffer });
  const parsed = parseBlogPostsFromHtml(result.value, options);
  return {
    ...parsed,
    conversionMessages: result.messages || [],
    html: result.value
  };
}

module.exports = {
  parseBlogPostsFromDocxBuffer,
  parseBlogPostsFromHtml,
  parseItalianDateToIso,
  slugify,
  stripHtml
};
