import DashboardLayout from '../components/layout/DashboardLayout';
import OptionChain from '../features/optionChain';

/**
 * Follows the same pattern as Dashboard.jsx and AdminDashboard.jsx: the page
 * owns the layout chrome (Sidebar + TopBar), the feature folder owns the
 * content. Without this wrapper the option chain would render bare, with no
 * sidebar and no top bar.
 */
export default function OptionChainPage() {
  return (
    <DashboardLayout>
      <OptionChain />
    </DashboardLayout>
  );
}
