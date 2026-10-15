export default {
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // property test 會建立很多個 fake-indexeddb 資料庫，給寬一點的時間上限
    testTimeout: 120_000,
  },
}
