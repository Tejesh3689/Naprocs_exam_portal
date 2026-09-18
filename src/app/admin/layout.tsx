"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Library, Activity, Settings, LogOut, Users, Briefcase, KeyRound } from 'lucide-react';
import { ReactNode } from 'react';

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  
  const isActive = (path: string) => {
    if (path === '/admin') return pathname === '/admin';
    // Use exact matching for high-level directories or regex boundary
    return pathname === path || pathname.startsWith(`${path}/`);
  };

  if (pathname === '/admin/login') {
    return (
      <div className="min-h-screen bg-background font-sans selection:bg-none">
        {children}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row font-sans selection:bg-none">
      {/* Decorative noise background */}
      <div className="fixed inset-0 bg-noise opacity-[0.03] pointer-events-none z-0" />
      
      {/* Sidebar Navigation */}
      <aside className="w-full md:w-64 border-r border-border/40 bg-card/40 backdrop-blur-xl shrink-0 flex flex-col relative z-20">
        <div className="p-6 border-b border-border/40">
          <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-primary to-accent">
            Naprocs Admin
          </h1>
          <p className="text-xs text-muted-foreground mt-1">Placement Control Center</p>
        </div>
        
        <nav className="flex-1 p-4 space-y-2">
          <Link 
            href="/admin" 
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive('/admin') ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}`}
          >
            <LayoutDashboard className="h-4 w-4" /> Dashboard Overview
          </Link>
          <Link 
            href="/admin/control-center" 
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive('/admin/control-center') ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}`}
          >
            <Activity className="h-4 w-4" /> Live Monitoring
            <span className="ml-auto inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          </Link>
          <Link
            href="/admin/drives"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive('/admin/drives') ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}`}
          >
            <Briefcase className="h-4 w-4" /> Recruitment Drives
          </Link>
          <Link 
            href="/admin/drive" 
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive('/admin/drive') ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}`}
          >
            <LayoutDashboard className="h-4 w-4" /> Live Kanban
          </Link>
          <Link
            href="/admin/leaderboard"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive('/admin/leaderboard') ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}`}
          >
            <Users className="h-4 w-4" /> Leaderboard
          </Link>
          <Link 
            href="/admin/questions" 
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive('/admin/questions') ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}`}
          >
            <Library className="h-4 w-4" /> Question Bank
          </Link>
          <Link
            href="/admin/settings"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive('/admin/settings') ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}`}
          >
            <Settings className="h-4 w-4" /> Settings
          </Link>
          <Link
            href="/admin/pin-lookup"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive('/admin/pin-lookup') ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}`}
          >
            <KeyRound className="h-4 w-4" /> PIN Lookup
          </Link>
        </nav>
        
        <div className="p-4 border-t border-border/40 mt-auto">
          <button 
            onClick={async () => {
              try {
                await fetch('/api/auth/admin-logout', { method: 'POST' });
                window.location.href = '/admin/login';
              } catch (e) {
                console.error("Sign Out Failure");
              }
            }}
            className="flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors hover:bg-destructive/10 text-destructive/80 hover:text-destructive"
          >
            <LogOut className="h-4 w-4" /> Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 w-full flex flex-col min-h-screen relative z-10 overflow-x-hidden">
        {children}
      </main>
    </div>
  );
}
