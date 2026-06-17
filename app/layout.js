import "./globals.css";

export const metadata = {
  title: "YouTube Sync",
  description: "Simple YouTube watch party sync app",
};

export default function RootLayout({ children }) {
  return (
      <html lang="en">
      <body>{children}</body>
      </html>
  );
}