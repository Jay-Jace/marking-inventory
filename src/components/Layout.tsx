import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { UserRole } from '../types';
import {
  LayoutDashboard,
  Upload,
  Download,
  Database,
  PackageCheck,
  ClipboardList,
  LogOut,
  Menu,
} from 'lucide-react';

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  roles: UserRole[];
}

const navItems: NavItem[] = [
  {
    label: '대시보드',
    path: '/admin/dashboard',
    icon: <LayoutDashboard size={18} />,
    roles: ['admin'],
  },
  {
    label: '작업지시서 업로드',
    path: '/admin/workorder',
    icon: <Upload size={18} />,
    roles: ['admin'],
  },
  {
    label: '양식 다운로드',
    path: '/admin/downloads',
    icon: <Download size={18} />,
    roles: ['admin'],
  },
  {
    label: 'BOM 관리',
    path: '/admin/bom',
    icon: <Database size={18} />,
    roles: ['admin'],
  },
  {
    label: '발송 확인',
    path: '/offline/shipment',
    icon: <PackageCheck size={18} />,
    roles: ['offline'],
  },
  {
    label: '입고 확인',
    path: '/playwith/receipt',
    icon: <PackageCheck size={18} />,
    roles: ['playwith'],
  },
  {
    label: '마킹 작업',
    path: '/playwith/marking',
    icon: <ClipboardList size={18} />,
    roles: ['playwith'],
  },
];

interface LayoutProps {
  children: React.ReactNode;
  role: UserRole;
  userName: string;
}

export default function Layout({ children, role, userName }: LayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const roleLabel = {
    admin: '관리자',
    offline: '오프라인 매장',
    playwith: '플레이위즈',
  }[role];

  const filteredNav = navItems.filter((item) => item.roles.includes(role));

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex bg-gray-100">
      {/* 모바일 오버레이 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 사이드바 */}
      <aside
        className={`fixed inset-y-0 left-0 w-64 bg-gray-900 text-white flex flex-col z-30 transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 lg:static lg:inset-0`}
      >
        <div className="p-5 border-b border-gray-700">
          <h1 className="text-lg font-bold text-white">마킹 재고 관리</h1>
          <p className="text-xs text-gray-400 mt-1">{roleLabel} · {userName}</p>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {filteredNav.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors
                ${location.pathname === item.path
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-700">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
          >
            <LogOut size={18} />
            로그아웃
          </button>
        </div>
      </aside>

      {/* 메인 영역 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 모바일 헤더 */}
        <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded-md hover:bg-gray-100"
          >
            <Menu size={20} />
          </button>
          <span className="font-semibold text-gray-900">마킹 재고 관리</span>
        </header>

        <main className="flex-1 p-4 lg:p-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
