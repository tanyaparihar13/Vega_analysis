import { memo, useState } from 'react';
import { TbMathFunction, TbLoader2 } from 'react-icons/tb';
import FeaturePreviewPanel from './FeaturePreviewPanel';
import api from '../../api/axios';

const GREEK_FIELDS = [
  { key: 'delta', label: 'Delta' },
  { key: 'gamma', label: 'Gamma' },
  { key: 'theta', label: 'Theta' },
  { key: 'vega', label: 'Vega' },
  { key: 'rho', label: 'Rho' },
];

/**
 * This card calls POST /api/greeks/calculate only when the user presses
 * "Calculate" — there is no polling, no interval, and it is not subscribed
 * to the live tick feed. Greeks here are deliberately on-demand.
 */
function GreeksPreviewCard({ isPremium }) {
  const [form, setForm] = useState({ spot: '22000', strike: '22000', iv: '15', daysToExpiry: '7', optionType: 'CE' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleCalculate = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.post('/greeks/calculate', {
        spot: Number(form.spot),
        strike: Number(form.strike),
        iv: Number(form.iv) / 100,
        daysToExpiry: Number(form.daysToExpiry),
        optionType: form.optionType,
      });
      setResult(data.result);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not calculate Greeks');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <FeaturePreviewPanel icon={TbMathFunction} title="Greeks Engine" phaseLabel="Manual" locked={!isPremium}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <LabeledInput label="Spot" value={form.spot} onChange={update('spot')} />
          <LabeledInput label="Strike" value={form.strike} onChange={update('strike')} />
          <LabeledInput label="IV %" value={form.iv} onChange={update('iv')} />
          <LabeledInput label="Days" value={form.daysToExpiry} onChange={update('daysToExpiry')} />
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Type</label>
            <select value={form.optionType} onChange={update('optionType')} className="input-dark w-full py-1.5 text-xs">
              <option value="CE">CE (Call)</option>
              <option value="PE">PE (Put)</option>
            </select>
          </div>
        </div>

        <button
          onClick={handleCalculate}
          disabled={loading}
          className="btn-primary flex w-full items-center justify-center gap-2 py-2 text-sm disabled:opacity-60"
        >
          {loading && <TbLoader2 size={16} className="animate-spin" />}
          Calculate
        </button>

        {error && <p className="text-xs text-vega-red">{error}</p>}

        {result && (
          <div className="grid grid-cols-5 gap-2 pt-1">
            {GREEK_FIELDS.map(({ key, label }) => (
              <div key={key} className="rounded-lg border border-vega-border/60 bg-white/5 p-2 text-center">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
                <div className="num text-sm text-slate-800">{result[key]}</div>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-gray-600">
          Calculated on demand via <code className="text-gray-500">POST /api/greeks/calculate</code> — Black-Scholes,
          not streamed from ticks. Batch chain wiring lands in Phase 3/4.
        </p>
      </div>
    </FeaturePreviewPanel>
  );
}

function LabeledInput({ label, value, onChange }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">{label}</label>
      <input value={value} onChange={onChange} inputMode="decimal" className="input-dark w-full py-1.5 text-xs" />
    </div>
  );
}

export default memo(GreeksPreviewCard);
