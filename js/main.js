/* ============================================
   Alfano Ministries — Main JS
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {

    // ── Mobile Menu Toggle ──
    const hamburger = document.querySelector('.hamburger');
    const navLinks = document.querySelector('.nav-links');

    if (hamburger && navLinks) {
        hamburger.addEventListener('click', () => {
            hamburger.classList.toggle('open');
            navLinks.classList.toggle('open');
        });

        // Close menu when a link is clicked
        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                hamburger.classList.remove('open');
                navLinks.classList.remove('open');
            });
        });
    }

    // ── Navbar scroll effect ──
    const navbar = document.querySelector('.navbar');
    if (navbar) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 50) {
                navbar.classList.add('scrolled');
            } else {
                navbar.classList.remove('scrolled');
            }
        });
    }

    // ── Scroll fade-in animations ──
    const fadeEls = document.querySelectorAll('.fade-in');
    if (fadeEls.length > 0) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.1,
            rootMargin: '0px 0px -40px 0px'
        });

        fadeEls.forEach(el => observer.observe(el));
    }

    // ── Active nav link highlight ──
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a').forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage || (currentPage === '' && href === 'index.html')) {
            link.classList.add('active');
        }
    });

    // ── Podcast RSS Loader ──
    const RSS_FEED = 'https://anchor.fm/s/f4cac4f8/podcast/rss';
    const RSS_API = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(RSS_FEED);
    const PODCAST_ART = 'https://d3t3ozftmdmh3i.cloudfront.net/production/podcast_uploaded_nologo/40969294/40969294-1713838427761-d93b6e3c8f43.jpg';

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    }

    function buildEpisodeCard(ep, index) {
        const img = ep.thumbnail || PODCAST_ART;
        const desc = stripHtml(ep.description).substring(0, 180) + '...';
        const date = formatDate(ep.pubDate);
        const epNum = ep.itunes_episode || (index !== undefined ? '' : '');

        return `
            <div class="episode-card">
                <img class="episode-card-img" src="${img}" alt="${ep.title}" loading="lazy" onerror="this.src='${PODCAST_ART}'">
                <div class="episode-card-body">
                    <div class="episode-meta">
                        ${epNum ? `<span class="episode-number">EP ${epNum}</span><span class="episode-dot"></span>` : ''}
                        <span>${date}</span>
                    </div>
                    <h3>${ep.title}</h3>
                    <p class="episode-desc">${desc}</p>
                    <audio class="episode-player" controls preload="none" src="${ep.enclosure.link}"></audio>
                    <a class="episode-link" href="${ep.link}" target="_blank" rel="noopener">Listen on Spotify &rarr;</a>
                </div>
            </div>
        `;
    }

    function loadPodcastEpisodes() {
        const containers = document.querySelectorAll('[data-podcast-feed]');
        if (containers.length === 0) return;

        containers.forEach(container => {
            const count = parseInt(container.getAttribute('data-episode-count') || '6', 10);
            container.innerHTML = '<div class="episode-loading"><div class="spinner"></div><p>Loading episodes...</p></div>';

            fetch(RSS_API)
                .then(res => res.json())
                .then(data => {
                    if (data.status !== 'ok' || !data.items || data.items.length === 0) {
                        throw new Error('No episodes found');
                    }
                    const episodes = data.items.slice(0, count);
                    const cards = episodes.map((ep, i) => buildEpisodeCard(ep, i)).join('');
                    container.innerHTML = `<div class="episode-grid">${cards}</div>`;
                })
                .catch(() => {
                    // Fallback: show Spotify embed player
                    container.innerHTML = `
                        <div style="max-width: 800px; margin: 0 auto;">
                            <iframe style="border-radius: 12px; width: 100%; height: 352px; border: none;" src="https://open.spotify.com/embed/show/6OuaAK03zmDwKwQCxG47mx?theme=0" allowfullscreen loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>
                        </div>
                    `;
                });
        });
    }

    loadPodcastEpisodes();

    // ── Mailing List Popup ──
    const POPUP_KEY = 'am_popup_dismissed';
    const POPUP_DAYS = 7; // show again after 7 days

    function shouldShowPopup() {
        const dismissed = localStorage.getItem(POPUP_KEY);
        if (!dismissed) return true;
        const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
        return daysSince >= POPUP_DAYS;
    }

    function dismissPopup() {
        localStorage.setItem(POPUP_KEY, Date.now().toString());
        const overlay = document.querySelector('.popup-overlay');
        if (overlay) overlay.classList.remove('active');
    }

    if (shouldShowPopup()) {
        const overlay = document.createElement('div');
        overlay.className = 'popup-overlay';
        overlay.innerHTML = `
            <div class="popup-box">
                <button class="popup-close" aria-label="Close">&times;</button>
                <div class="popup-eyebrow">Stay Connected</div>
                <h2>Join Our Mailing List</h2>
                <div class="popup-divider"></div>
                <p>Get ministry updates, event announcements, and encouragement delivered straight to your inbox.</p>
                <form class="popup-form" action="https://go.alfanoministries.com/contact" method="GET">
                    <input type="email" name="email" placeholder="Your email address" required>
                    <button type="submit">Subscribe</button>
                </form>
                <button class="popup-no-thanks">No thanks</button>
            </div>
        `;
        document.body.appendChild(overlay);

        setTimeout(() => {
            overlay.classList.add('active');
        }, 3000);

        overlay.querySelector('.popup-close').addEventListener('click', dismissPopup);
        overlay.querySelector('.popup-no-thanks').addEventListener('click', dismissPopup);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) dismissPopup();
        });

        overlay.querySelector('.popup-form').addEventListener('submit', () => {
            localStorage.setItem(POPUP_KEY, Date.now().toString());
        });
    }

});

// ── Copy-to-clipboard with feedback ──
function copyToClipboard(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 2000);
    });
}
