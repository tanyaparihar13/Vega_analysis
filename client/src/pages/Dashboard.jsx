import { forwardRef, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { TbChartCandle } from 'react-icons/tb';
import { useAuth } from '../context/AuthContext';
import DashboardLayout from '../components/layout/DashboardLayout';
import IndexCardGrid from '../components/market/IndexCardGrid';
import MarketChartPanel from '../components/market/MarketChartPanel';
import LiveMarketTable from '../components/market/LiveMarketTable';
import StatusCardsRow from '../components/market/StatusCardsRow';
import OptionChainPreviewCard from '../components/market/OptionChainPreviewCard';
import GreeksPreviewCard from '../components/market/GreeksPreviewCard';
import MarketDepthPanel from '../components/market/MarketDepthPanel';
import RecentTradesPanel from '../components/market/RecentTradesPanel';
import WatchlistPreviewCard from '../components/market/WatchlistPreviewCard';

const fadeUp = {
  hidden: { opacity: 0, y: 8 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.28, delay: i * 0.04, ease: 'easeOut' } }),
};

const Section = forwardRef(function Section({ index, className = '', children }, ref) {
  return (
    <motion.div ref={ref} className={className} custom={index} initial="hidden" animate="show" variants={fadeUp}>
      {children}
    </motion.div>
  );
});

export default function Dashboard() {
  const { user } = useAuth();
  const isPremium = user?.role === 'premium' || user?.role === 'admin';
  const [highlightTable, setHighlightTable] = useState(false);
  const marketTableRef = useRef(null);

  const handleJumpToSymbol = () => {
    marketTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightTable(true);
    setTimeout(() => setHighlightTable(false), 1500);
  };

  return (
    <DashboardLayout onJumpToSymbol={handleJumpToSymbol}>
      <Section index={0} className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Trading Dashboard</h1>
          <p className="text-sm text-gray-500">Live indices, chart, and the option analytics stack as each phase ships.</p>
        </div>
      </Section>

      <Section index={1}>
        <StatusCardsRow />
      </Section>

      <Section index={2}>
        <IndexCardGrid />
      </Section>

      <Section index={3} className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <MarketChartPanel />
        </div>
        <div className="space-y-5">
          <StatusMini />
          <RecentTradesPanel />
        </div>
      </Section>

      <Section index={4} className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <OptionChainPreviewCard isPremium={isPremium} />
        <GreeksPreviewCard isPremium={isPremium} />
      </Section>

      <Section index={5} ref={marketTableRef}>
        <div
          className={`rounded-xl transition-shadow duration-500 ${
            highlightTable ? 'shadow-glow-cyan ring-1 ring-vega-cyan/50' : ''
          }`}
        >
          <LiveMarketTable delayed={!isPremium} />
        </div>
      </Section>

      <Section index={6} className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <WatchlistPreviewCard />
        <MarketDepthPanel />
      </Section>
    </DashboardLayout>
  );
}

function StatusMini() {
  return (
    <div className="glass-card flex items-center gap-3 p-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/5">
        <TbChartCandle size={18} className="text-vega-cyan" />
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-500">Chart Source</div>
        <div className="text-sm font-medium text-gray-200">Live ticks (TradingView widget in Phase 2)</div>
      </div>
    </div>
  );
}
