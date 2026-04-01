"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase";
import { usePathname, useRouter } from "next/navigation";
import type { User, SupabaseClient } from "@supabase/supabase-js";

type Role = "admin" | "viewer";

interface AuthContextValue {
  user: User | null;
  role: Role | null;
  isLoading: boolean;
  supabase: SupabaseClient;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Initial session check
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user);
        setRole((session.user.app_metadata?.role as Role) || "viewer");
      }
      setIsLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(session.user);
        setRole((session.user.app_metadata?.role as Role) || "viewer");
      } else {
        setUser(null);
        setRole(null);
      }
      setIsLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setRole(null);
    router.push("/login");
  };

  // Don't redirect on login page
  const isLoginPage = pathname === "/login";

  // Show loading spinner while checking auth
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // If not logged in and not on login page, redirect
  if (!user && !isLoginPage) {
    router.push("/login");
    return null;
  }

  // If logged in and on login page, redirect to dashboard
  if (user && isLoginPage) {
    router.push(role === "viewer" ? "/clients" : "/");
    return null;
  }

  return (
    <AuthContext.Provider value={{ user, role, isLoading, supabase, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
