import { redirect } from 'next/navigation';

/** Authenticated home is the Overview dashboard (legacy default tab). */
export default function Home() {
  redirect('/overview');
}
