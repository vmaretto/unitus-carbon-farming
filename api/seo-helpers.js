'use strict';

const MAX_SEO_TITLE = 70;
const MAX_META_DESC = 180;
const MAX_COVER_ALT = 200;

function truncate(s, max) {
  if (!s) return s;
  s = String(s).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function parseItalianDate(s) {
  if (!s) return null;
  const months = { gennaio:0,febbraio:1,marzo:2,aprile:3,maggio:4,giugno:5,luglio:6,agosto:7,settembre:8,ottobre:9,novembre:10,dicembre:11 };
  const m = String(s).match(/(\d{1,2})\s+([a-zà]+)\s+(\d{4})/i);
  if (!m) return null;
  const monthKey = m[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const month = months[monthKey];
  if (month === undefined) return null;
  return new Date(Date.UTC(parseInt(m[3],10), month, parseInt(m[1],10), 9, 0, 0));
}

function parseMetadataBlock(text) {
  const meta = {
    publishedAt: null, authorName: 'Redazione Master Carbon Farming',
    tags: [], module: null, primarySource: null,
    seoTitle: null, metaDescription: null, focusKeyword: null,
    suggestedSlug: null, pillarSlug: null, coverAlt: null,
  };
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    switch (key) {
      case 'data pubblicazione': meta.publishedAt = parseItalianDate(value); break;
      case 'autore': meta.authorName = value; break;
      case 'tag': meta.tags = value.split(',').map(t => t.trim()).filter(Boolean); break;
      case 'modulo del master collegato':
      case 'modulo': meta.module = value; break;
      case 'fonte primaria': meta.primarySource = value; break;
      case 'seo title': meta.seoTitle = truncate(value, MAX_SEO_TITLE); break;
      case 'meta description': meta.metaDescription = truncate(value, MAX_META_DESC); break;
      case 'focus keyword': meta.focusKeyword = value; break;
      case 'slug (suggerito)':
      case 'slug suggerito':
      case 'slug': meta.suggestedSlug = slugify(value); break;
      case 'pillar link':
      case 'pillar slug': meta.pillarSlug = slugify(value); break;
      case 'cover alt text':
      case 'alt text (it)':
      case 'cover alt': meta.coverAlt = truncate(value, MAX_COVER_ALT); break;
    }
  }
  return meta;
}

function extractCoverAltFromMediaBlock(text) {
  if (!text) return null;
  const m = String(text).match(/Alt text \(it\):\s*(.+?)(?:\r?\n|$)/i);
  return m ? truncate(m[1].trim(), MAX_COVER_ALT) : null;
}

module.exports = {
  truncate, slugify, parseItalianDate,
  parseMetadataBlock, extractCoverAltFromMediaBlock,
  MAX_SEO_TITLE, MAX_META_DESC, MAX_COVER_ALT,
};
