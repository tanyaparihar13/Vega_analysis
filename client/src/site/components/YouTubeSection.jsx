import { useState } from 'react';
import { motion } from 'framer-motion';
import { FaYoutube, FaPlay } from 'react-icons/fa';
import { HiOutlineArrowRight, HiOutlineExternalLink } from 'react-icons/hi';
import { YOUTUBE, LATEST_VIDEOS } from '../content';

/**
 * "Learn Professional Vega Trading" — the channel section.
 *
 * THE PLAYER IS A FACADE UNTIL IT IS CLICKED. A YouTube <iframe> costs roughly
 * a megabyte of script and sets third-party cookies before anyone asks to watch
 * anything, and this page already carries a live chart. So each video renders
 * as a thumbnail plus a play button, and the real iframe is only mounted after
 * a click. That is the single biggest performance decision on this page.
 *
 * Embeds use youtube-nocookie.com — the same video, without the tracking
 * cookies being written for visitors who never press play elsewhere on the
 * page.
 *
 * NO INVENTED CHANNEL STATISTICS. Subscriber and view counts need a YouTube
 * Data API key and a server call to fetch, and this work must not touch the
 * backend. Rather than print a plausible-looking number that nobody can verify,
 * the channel card states what is actually known and links out — where the real
 * counts are one click away and always current.
 */

const thumb = (id) => `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
const thumbFallback = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

const fmtDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
};

export default function YouTubeSection() {
  const featured = LATEST_VIDEOS[0];
  const [activeId, setActiveId] = useState(featured?.id ?? null);
  const [playing, setPlaying] = useState(false);

  const active = LATEST_VIDEOS.find((v) => v.id === activeId) ?? featured;

  /** Selecting from the grid swaps the player and starts it straight away. */
  const choose = (id) => {
    setActiveId(id);
    setPlaying(true);
  };

  if (!featured) return null;

  return (
    <section id="learning" className="relative px-5 py-20 sm:px-8 sm:py-28">
      <div className="mx-auto max-w-[1400px]">
        {/* ---------- heading ---------- */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.55 }}
          className="mx-auto mb-14 max-w-3xl text-center"
        >
          <span className="site-badge !border-[#FF0033]/30 !text-[#FF4D6D]" style={{ backgroundColor: 'rgba(255,0,51,0.10)' }}>
            <FaYoutube size={14} /> {YOUTUBE.handle}
          </span>
          <h2 className="mt-5 font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl lg:text-5xl">
            Learn Professional{' '}
            <span className="site-gradient-text">Vega Trading</span>
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted">
            Watch advanced Vega analysis, live market breakdowns, and professional
            trading education.
          </p>
        </motion.div>

        <div id="youtube" className="grid grid-cols-1 gap-6 lg:grid-cols-[1.75fr_1fr]">
          {/* ---------- featured player ---------- */}
          <motion.div
            initial={{ opacity: 0, y: 26 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.55 }}
            className="site-ring"
          >
            <div className="site-ring-inner overflow-hidden">
              <div className="relative aspect-video w-full bg-black">
                {playing ? (
                  <iframe
                    key={active.id}
                    src={`https://www.youtube-nocookie.com/embed/${active.id}?autoplay=1&rel=0&modestbranding=1`}
                    title={active.title}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className="absolute inset-0 h-full w-full"
                  />
                ) : (
                  <Facade video={active} onPlay={() => setPlaying(true)} large />
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-white/[0.08] px-5 py-4">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-body text-sm font-semibold text-text">
                    {active.title}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted">
                    {YOUTUBE.channelName} · {fmtDate(active.date)}
                  </p>
                </div>
                <a
                  href={`https://www.youtube.com/watch?v=${active.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs font-semibold text-muted transition-colors hover:text-primary"
                >
                  Watch on YouTube <HiOutlineExternalLink size={12} className="inline" />
                </a>
              </div>
            </div>
          </motion.div>

          {/* ---------- channel card ---------- */}
          <motion.div
            initial={{ opacity: 0, y: 26 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.55, delay: 0.1 }}
            className="site-card flex flex-col justify-between p-7"
            style={{ boxShadow: '0 24px 70px -30px rgba(255,0,51,0.55), inset 0 1px 0 0 rgba(255,255,255,0.06)' }}
          >
            <div>
              <div
                className="grid h-14 w-14 place-items-center rounded-2xl text-white"
                style={{
                  backgroundColor: '#FF0033',
                  boxShadow: '0 10px 30px -8px rgba(255,0,51,0.8)',
                }}
              >
                <FaYoutube size={28} />
              </div>

              <h3 className="mt-5 font-display text-2xl font-bold text-text">
                {YOUTUBE.channelName}
              </h3>
              <p className="mt-1 font-mono text-sm text-muted">{YOUTUBE.handle}</p>

              <p className="mt-5 text-sm leading-relaxed text-muted">
                The official channel behind Vega Analysis. Walkthroughs of the Vega
                software, how to read Call and Put vega during a session, and market
                breakdowns recorded on real trading days.
              </p>

              <ul className="mt-6 space-y-2.5 border-t border-white/[0.08] pt-5">
                {[
                  'Vega software walkthroughs',
                  'Live session breakdowns',
                  'Options Greeks explained',
                ].map((t) => (
                  <li key={t} className="flex items-center gap-2.5 text-sm text-muted">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_8px_#00E676]" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-7 flex flex-col gap-3">
              <a
                href={YOUTUBE.subscribeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="site-tap-clean inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 font-body font-semibold text-white transition-all duration-300 hover:-translate-y-0.5"
                style={{
                  backgroundColor: '#FF0033',
                  boxShadow: '0 10px 30px -10px rgba(255,0,51,0.9)',
                }}
              >
                <FaYoutube size={19} /> Subscribe
              </a>
              <a
                href={YOUTUBE.videosUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="site-btn-outline w-full !py-2.5 !text-sm"
              >
                All videos <HiOutlineArrowRight size={15} />
              </a>
            </div>
          </motion.div>
        </div>

        {/* ---------- grid ---------- */}
        <div className="mt-6 grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-5">
          {LATEST_VIDEOS.slice(1, 6).map((v, i) => (
            <motion.button
              key={v.id}
              type="button"
              onClick={() => choose(v.id)}
              initial={{ opacity: 0, y: 22 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              transition={{ duration: 0.4, delay: i * 0.06 }}
              className="site-card-hover group overflow-hidden p-0 text-left"
            >
              <div className="relative aspect-video w-full overflow-hidden bg-black">
                <Facade video={v} onPlay={() => choose(v.id)} compact />
              </div>
              <div className="p-3.5">
                <h4 className="line-clamp-2 font-body text-xs font-semibold leading-snug text-text transition-colors group-hover:text-primary">
                  {v.title}
                </h4>
                <p className="mt-1.5 text-[11px] text-muted">{fmtDate(v.date)}</p>
              </div>
            </motion.button>
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-muted/70">
          Videos load only when you press play.
        </p>
      </div>
    </section>
  );
}

/**
 * Thumbnail + play button standing in for the real iframe.
 *
 * `maxresdefault` does not exist for every upload — YouTube only generates it
 * above a certain source resolution — so a 404 falls back to `hqdefault`, which
 * always exists. Without that, older videos would show a broken image.
 */
function Facade({ video, onPlay, large = false, compact = false }) {
  const [src, setSrc] = useState(thumb(video.id));

  const content = (
    <>
      <img
        src={src}
        onError={() => setSrc(thumbFallback(video.id))}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
      <span
        className={`absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-white transition-all duration-300 group-hover:scale-110 ${
          large ? 'h-[68px] w-[68px]' : 'h-11 w-11'
        }`}
        style={{
          backgroundColor: '#FF0033',
          boxShadow: '0 8px 30px -6px rgba(255,0,51,0.85)',
        }}
      >
        <FaPlay size={large ? 24 : 14} className="ml-0.5" />
      </span>
    </>
  );

  // In the grid the whole card is already a <button>, so nesting another one
  // would be invalid HTML and unreachable by keyboard.
  if (compact) {
    return <span className="group absolute inset-0 block">{content}</span>;
  }

  return (
    <button
      type="button"
      onClick={onPlay}
      aria-label={`Play: ${video.title}`}
      className="group absolute inset-0 block h-full w-full"
    >
      {content}
    </button>
  );
}
