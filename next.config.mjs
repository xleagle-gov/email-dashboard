/** @type {import('next').NextConfig} */
// API rewrites to Lambda by default; set NEXT_PUBLIC_USE_LOCAL_BACKEND=true to use local Flask (e.g. dev)
const useLocalBackend = process.env.NEXT_PUBLIC_USE_LOCAL_BACKEND === 'true';
const apiDestination = useLocalBackend
  ? 'http://127.0.0.1:5050/api/:path*'
  : 'https://jnvbsyjaddwr6zlkg5f4hpecby0forwx.lambda-url.us-east-2.on.aws/api/:path*';

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: apiDestination,
      },
    ];
  },
};

export default nextConfig;
