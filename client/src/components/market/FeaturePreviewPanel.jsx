import { memo } from 'react';

function PremiumLock({ feature }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-vega-panel/85 px-6 text-center backdrop-blur-sm">
      <p className="mb-1 font-medium text-gray-300">🔒 Premium Feature</p>
      <p className="mb-4 text-sm text-gray-500">Upgrade to Premium to unlock {feature}.</p>
      <button className="btn-primary text-sm">Upgrade Now</button>
    </div>
  );
}

function FeaturePreviewPanel({ icon: Icon, title, phaseLabel, description, locked, className = '', children }) {
  return (
    <div className={`glass-card relative min-h-[220px] overflow-hidden p-5 ${className}`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={16} className="text-vega-cyan" />}
          <h2 className="font-semibold text-slate-900">{title}</h2>
        </div>
        {phaseLabel && (
          <span className="rounded-full border border-vega-border bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
            {phaseLabel}
          </span>
        )}
      </div>

      {children || <p className="text-sm text-gray-500">{description}</p>}

      {locked && <PremiumLock feature={title} />}
    </div>
  );
}

export default memo(FeaturePreviewPanel);
