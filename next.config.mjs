/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://jnvbsyjaddwr6zlkg5f4hpecby0forwx.lambda-url.us-east-2.on.aws/api/:path*',
      },
    ];
  },
};

export default nextConfig;
