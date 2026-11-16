const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../api/index');
const editionId = '11111111-1111-4111-8111-111111111111';
const optionId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';

async function invoke(path, method, { role = 'student', authenticated = true, body = {}, params = {}, user = userId } = {}) {
    const layer = api.app._router.stack.find(entry => entry.route?.path === path && entry.route.methods[method]);
    assert.ok(layer, path);
    const req = { body, params: { editionId, ...params }, headers: authenticated ? { authorization: 'Bearer ' + api.__generateToken({ role, userId: user }) } : {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    for (const entry of layer.route.stack) {
        let next = false;
        await entry.handle(req, res, () => { next = true; });
        if (!next) break;
    }
    return res;
}

function fakePool(t, { enrolled = true, open = true, active = true, allowChanges = true, previous = null, available = true, fail = false } = {}) {
    const queries = [];
    let releases = 0;
    const client = {
        async query(sql, args = []) {
            const text = sql.replace(/\s+/g, ' ').trim(); queries.push({ text, args });
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
            if (text.startsWith('SELECT id, is_active')) { assert.match(text, /FOR UPDATE/); return { rows: [{ id: editionId, is_active: active }] }; }
            if (text.startsWith('SELECT e.id FROM enrollments')) {
                assert.deepEqual(args, [userId, editionId]);
                assert.match(text, /e.status = 'active'/); assert.match(text, /u.is_active/); assert.match(text, /FOR SHARE OF e, u/);
                return { rows: enrolled ? [{ id: 'enrollment' }] : [] };
            }
            if (text.startsWith('SELECT is_open')) return { rows: [{ is_open: open, allow_changes: allowChanges }] };
            if (text.startsWith('SELECT option_id')) return { rows: previous ? [{ option_id: previous }] : [] };
            if (text.startsWith('SELECT id FROM specialist_options')) { assert.deepEqual(args, [optionId, editionId]); assert.match(text, /AND is_active/); return { rows: available ? [{ id: optionId }] : [] }; }
            if (text.startsWith('INSERT INTO specialist_choices')) {
                assert.deepEqual(args, [userId, editionId, optionId]);
                assert.match(text, /ON CONFLICT \(user_id, course_edition_id\)/);
                if (fail) throw new Error('Simulated write failure');
                return { rows: [{ selectedOptionId: optionId, selectedAt: '2026-11-16T10:00:00Z' }] };
            }
            throw new Error('Unexpected SQL: ' + text);
        },
        release() { releases++; }
    };
    api.__setPool({ connect: async () => client });
    t.after(() => api.__setPool(null));
    return { queries, get releases() { return releases; } };
}
const choicePath = '/api/lms/specializations/:editionId/choice';

test('specialist routes reject anonymous users and non-student roles', async () => {
    for (const [path, method] of [['/api/lms/specializations', 'get'], [choicePath, 'put']]) {
        assert.equal((await invoke(path, method, { authenticated: false })).statusCode, 401);
        for (const role of ['guest', 'teacher', 'admin']) assert.equal((await invoke(path, method, { role })).statusCode, 403);
    }
    for (const [path, method] of [
        ['/api/admin/specializations/:editionId', 'get'],
        ['/api/admin/specializations/:editionId/settings', 'put'],
        ['/api/admin/specializations/:editionId/options', 'post'],
        ['/api/admin/specializations/:editionId/options/:optionId', 'put']
    ]) assert.notEqual((await invoke(path, method)).statusCode, 200);
});

test('student catalog is scoped to active enrollment and retains withdrawn selections', async (t) => {
    api.__setPool({ async query(sql, args) {
        assert.deepEqual(args, [userId]);
        assert.match(sql, /e.user_id = \$1 AND e.status = 'active'/);
        assert.match(sql, /u.is_active AND u.role = 'student'/);
        assert.match(sql, /AND o.is_active/);
        assert.match(sql, /chosen.id = ch.option_id/);
        return { rows: [{ editionId, options: [], selectedTitle: 'Modulo ritirato' }] };
    } });
    t.after(() => api.__setPool(null));
    const result = await invoke('/api/lms/specializations', 'get');
    assert.equal(result.statusCode, 200); assert.equal(result.body[0].selectedTitle, 'Modulo ritirato');
});

test('choice uses authenticated identity and commits one choice per edition', async (t) => {
    const pool = fakePool(t);
    const result = await invoke(choicePath, 'put', { body: { optionId, userId: otherId } });
    assert.equal(result.statusCode, 200); assert.equal(result.body.selectedOptionId, optionId);
    assert.equal(pool.queries.at(-1).text, 'COMMIT'); assert.equal(pool.releases, 1);
});

for (const [label, settings, status] of [
    ['no active enrollment', { enrolled: false }, 403],
    ['closed choices', { open: false }, 409],
    ['inactive edition', { active: false }, 409],
    ['locked previous choice', { previous: otherId, allowChanges: false }, 409],
    ['withdrawn option or option from another edition', { available: false }, 409]
]) test(`choice rejects ${label} and rolls back`, async (t) => {
    const pool = fakePool(t, settings);
    const result = await invoke(choicePath, 'put', { body: { optionId } });
    assert.equal(result.statusCode, status);
    assert.equal(pool.queries.at(-1).text, 'ROLLBACK'); assert.equal(pool.releases, 1);
    assert.ok(!pool.queries.some(query => query.text.startsWith('INSERT')));
});

test('allowed changes replace the previous choice', async (t) => {
    fakePool(t, { previous: otherId });
    assert.equal((await invoke(choicePath, 'put', { body: { optionId } })).statusCode, 200);
});

test('malformed identifiers are rejected before database access', async (t) => {
    const pool = fakePool(t);
    assert.equal((await invoke(choicePath, 'put', { body: { optionId: 'bad' } })).statusCode, 400);
    assert.equal((await invoke(choicePath, 'put', { body: { optionId }, params: { editionId: 'bad' } })).statusCode, 400);
    assert.equal(pool.queries.length, 0);
});

test('failed writes roll back and release the transaction', async (t) => {
    const pool = fakePool(t, { fail: true });
    assert.equal((await invoke(choicePath, 'put', { body: { optionId } })).statusCode, 500);
    assert.equal(pool.queries.at(-1).text, 'ROLLBACK'); assert.equal(pool.releases, 1);
});

// Invoke the admin handler after middleware has been tested above, independent
// of the developer's ADMIN_PASSWORD environment configuration.
async function adminHandler(path, method, body, params = {}) {
    const layer = api.app._router.stack.find(entry => entry.route?.path === path && entry.route.methods[method]);
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await layer.route.stack.at(-1).handle({ params: { editionId, ...params }, body }, res);
    return res;
}

test('admin rejects invalid settings and option fields', async (t) => {
    const pool = fakePool(t);
    const settingsPath = '/api/admin/specializations/:editionId/settings';
    assert.equal((await adminHandler(settingsPath, 'put', { isOpen: 'true', allowChanges: true })).statusCode, 400);
    const path = '/api/admin/specializations/:editionId/options';
    for (const body of [{ title: ' ' }, { title: 'a', isActive: 'false' }, { title: 'a', sortOrder: -1 }, { title: 'a', sortOrder: 1.5 }, { title: 'a', description: {} }]) {
        assert.equal((await adminHandler(path, 'post', body)).statusCode, 400);
    }
    assert.equal(pool.queries.length, 0);
});

test('admin creates, edits and closes options under the edition lock', async (t) => {
    let releases = 0;
    const queries = [];
    api.__setPool({ connect: async () => ({
        async query(sql, args = []) {
            const text = sql.replace(/\s+/g, ' ').trim(); queries.push(text);
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
            if (text.startsWith('SELECT id, is_active')) { assert.deepEqual(args, [editionId]); return { rows: [{ id: editionId }] }; }
            assert.ok(queries.includes('SELECT id, is_active FROM course_editions WHERE id = $1 FOR UPDATE'));
            if (text.startsWith('INSERT INTO specialist_settings')) { assert.deepEqual(args, [editionId, false, false]); return { rows: [] }; }
            if (text.startsWith('INSERT INTO specialist_options')) { assert.deepEqual(args, [editionId, 'Suolo', 'Descrizione', true, 2]); return { rows: [{ id: optionId, title: 'Suolo' }] }; }
            if (text.startsWith('UPDATE specialist_options')) {
                assert.match(text, /WHERE course_edition_id = \$1 AND id = \$6/);
                assert.deepEqual(args, [editionId, 'Suolo', '', false, 0, optionId]);
                return { rows: [{ id: optionId, isActive: false }] };
            }
            throw new Error(text);
        }, release() { releases++; }
    }) });
    t.after(() => api.__setPool(null));
    assert.equal((await adminHandler('/api/admin/specializations/:editionId/options', 'post', { title: ' Suolo ', description: ' Descrizione ', sortOrder: 2 })).body.title, 'Suolo');
    assert.equal((await adminHandler('/api/admin/specializations/:editionId/options/:optionId', 'put', { title: 'Suolo', isActive: false }, { optionId })).body.isActive, false);
    assert.equal((await adminHandler('/api/admin/specializations/:editionId/settings', 'put', { isOpen: false, allowChanges: false })).statusCode, 200);
    assert.equal(releases, 3); assert.equal(queries.filter(sql => sql === 'COMMIT').length, 3);
});
