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
            logoutBtn.style.display = 'none';
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

        const badge = document.createElement('button');
        badge.type = 'button';
        badge.innerHTML = '👁️';
        badge.title = window.__isTeacherGuestView ? 'Torna al pannello docenti' : 'Modalità consultazione';
        badge.setAttribute('aria-label', badge.title);
        badge.style.cssText = 'position:fixed;bottom:16px;left:16px;width:46px;height:46px;background:#fef3c7;color:#92400e;border:1px solid #f5d38a;border-radius:999px;font-size:1.1rem;z-index:1000;box-shadow:0 4px 14px rgba(0,0,0,0.12);cursor:pointer;display:flex;align-items:center;justify-content:center;';
        document.body.appendChild(badge);
        badge.addEventListener('click', () => {
            window.location.href = window.__isTeacherGuestView ? '/teachers/' : '/learn/index.html';
        });
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
