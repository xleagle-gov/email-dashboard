/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://ti37avgzhwitl3fsp7af5kvkx40fangu.lambda-url.us-east-2.on.aws/api/:path*',
      },
    ];
  },
};

export default nextConfig;
