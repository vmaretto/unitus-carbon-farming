(function() {
    let user = {};

    try {
        const stored = localStorage.getItem('learnUser');
        user = stored ? JSON.parse(stored) : {};
    } catch (_error) {
        user = {};
    }

    window.__guestUser = user;
    window.__isGuest = user.role === 'guest';
    window.__isTeacherGuestView = user.role === 'guest' && user.accessMode === 'student_view';
    window.__skipProgressTracking = window.__isGuest;

    if (!window.__isGuest) return;

    const restrictedPages = new Set([
        '/learn/checkin.html',
        '/learn/documents.html',
        '/learn/questions.html',
        '/learn/quiz.html',
        '/learn/surveys.html'
    ]);

    if (restrictedPages.has(window.location.pathname)) {
        window.location.replace('/learn/index.html');
        return;
    }

    document.addEventListener('DOMContentLoaded', () => {
        const logoutBtn = document.getElementById('logout-btn');
        if (window.__isTeacherGuestView && logoutBtn) {
            logoutBtn.textContent = '↩ Torna al pannello docenti';
            logoutBtn.setAttribute('href', '/teachers/');
            logoutBtn.setAttribute('aria-label', 'Torna al pannello docenti');
        }

        if (window.__isTeacherGuestView && !document.getElementById('teacher-guest-banner')) {
            const banner = document.createElement('div');
            banner.id = 'teacher-guest-banner';
            banner.innerHTML = `
                <div style="display:flex; align-items:center; gap:12px; justify-content:space-between; flex-wrap:wrap;">
                    <div>
                        <div style="font-weight:700; font-size:0.95rem; color:#92400e;">Vista docente in consultazione</div>
                        <div style="font-size:0.82rem; color:#a16207;">Contenuti studenti visibili senza tracking, quiz o progressi.</div>
                    </div>
                    <a href="/teachers/" style="display:inline-flex; align-items:center; gap:8px; padding:10px 14px; border-radius:999px; background:#1b3a2d; color:#fff; text-decoration:none; font-weight:600; font-size:0.85rem;">↩ Torna al pannello docenti</a>
                </div>
            `;
            banner.style.cssText = 'position:sticky; top:12px; z-index:999; margin:12px auto 0; max-width:min(1120px, calc(100vw - 24px)); background:#fffbeb; border:1px solid #f59e0b; color:#92400e; padding:12px 16px; border-radius:16px; box-shadow:0 10px 30px rgba(31,41,55,0.12);';
            document.body.prepend(banner);
        }

        document.querySelectorAll('nav a, .nav a, .sidebar a, .nav-links a').forEach((link) => {
            const href = link.getAttribute('href') || '';
            if (href.includes('checkin') || href.includes('documents') || href.includes('questions') || href.includes('quiz') || href.includes('surveys') || (window.__isTeacherGuestView && href.includes('calendar'))) {
                link.style.display = 'none';
            }
        });

        document.querySelectorAll('[data-progress-section], .progress-bar, .completion-badge').forEach((el) => {
            el.style.display = 'none';
        });

        const badge = document.createElement('div');
        badge.innerHTML = window.__isTeacherGuestView ? '👁️ Consultazione docente attiva' : '👁️ Modalità consultazione';
        badge.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#fef3c7;color:#92400e;padding:8px 16px;border-radius:999px;font-size:0.85rem;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,0.1);';
        document.body.appendChild(badge);
    });

    document.addEventListener('click', (event) => {
        if (!window.__isTeacherGuestView) return;
        const target = event.target && event.target.closest ? event.target.closest('#logout-btn') : null;
        if (!target) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        window.location.href = '/teachers/';
    }, true);
})();
