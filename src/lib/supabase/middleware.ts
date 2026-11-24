import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { closedSection } from '@/lib/closed-sections'
import { assertSupabaseTargetAllowed } from "./target"

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    (assertSupabaseTargetAllowed(process.env.NEXT_PUBLIC_SUPABASE_URL),
     process.env.NEXT_PUBLIC_SUPABASE_URL!),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isLoginPage = request.nextUrl.pathname === '/login'
  const isAuthCallback = request.nextUrl.pathname === '/auth/callback'

  if (!user && !isLoginPage && !isAuthCallback) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user && isLoginPage) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  // ── sections that are built and deliberately shut ───────────────────────
  //
  // ONE enforcement point rather than a guard copied into eight pages. The
  // nav greys these too, but **a grey link is not a permission** — anybody
  // can type a URL, and a check that lives only in the nav is the shape
  // that let a KA see a restriction nothing enforced.
  //
  // A REWRITE, not a redirect: the URL stays, so a bookmark still reads as
  // the thing it was and will work again when the section opens. And it
  // runs AFTER the auth gate, so a signed-out visitor still goes to /login
  // rather than being told what is closed.
  const closed = closedSection(request.nextUrl.pathname)
  if (user && closed) {
    const url = request.nextUrl.clone()
    url.pathname = '/closed'
    url.searchParams.set('from', request.nextUrl.pathname)
    url.searchParams.set('why', closed.reason)
    return NextResponse.rewrite(url)
  }

  return supabaseResponse
}
