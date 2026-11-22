/**
 * Script to clean up old Bluesky posts by removing copilot CLI model selection prefixes.
 * Finds posts from 2026-10-29 onwards and strips the "● Auto selected..." or "● Copilot Fusion selected..." prefix.
 * 
 * Since Bluesky doesn't allow editing posts (would break likes/replies), this script:
 * 1. Deletes posts with model selection prefixes
 * 2. Re-posts with cleaned text
 * 
 * Usage: node dist/cleanup-posts.js
 * Requires: BSKY_HANDLE and BSKY_PASSWORD environment variables
 */

import { AtpAgent } from '@atproto/api';

const startDate = '2026-10-29'; // Start date for cleanup

/**
 * Strips model selection prefix from copilot CLI output.
 * Handles both single-line and multi-line formats.
 */
function stripModelPrefix(output: string): string {
  // Remove "● " and any model selection text up to the first period followed by space and capital letter
  // Use [\\s\\n]+ to handle newlines and multiple spaces
  const match = output.match(/●\s+.+?\.\s*[\n]*\s*([A-ZÆØÅa-zæøå].*)/s);
  if (match) {
    return match[1].trim();
  }
  // Fallback: try removing everything before "● " (inclusive)
  const markerIndex = output.indexOf('● ');
  if (markerIndex !== -1) {
    const afterMarker = output.slice(markerIndex + 2).trim();
    // Remove model selection info up to first period followed by blank line or capital letter
    const fullMatch = afterMarker.match(/.*\.[ \n]*[ \n]*/s);
    if (fullMatch) {
      return afterMarker.slice(fullMatch[0].length).trim();
    }
    return afterMarker;
  }
  return output.trim();
}

/**
 * Check if text needs cleanup (contains model selection prefix)
 */
function needsCleanup(text: string): boolean {
  return text.includes('● ') && (text.includes(' selected ') || text.includes('Auto selected '));
}

/**
 * Clean text if needed
 */
function cleanText(text: string): string {
  if (!needsCleanup(text)) return text;
  
  // Clean the text
  const cleaned = stripModelPrefix(text);
  return cleaned || text;
}

async function main() {
  const handle = process.env.BSKY_HANDLE;
  const password = process.env.BSKY_PASSWORD;

  if (!handle || !password) {
    console.error('BSKY_HANDLE and BSKY_PASSWORD environment variables must be set');
    process.exit(1);
  }

  const agent = new AtpAgent({ service: 'https://bsky.social' });
  
  console.log(`Logging in as ${handle}...`);
  await agent.login({ identifier: handle, password });
  console.log('Logged in successfully\n');

  // Get user's posts using the author feed endpoint
  const startDateObj = new Date(startDate + 'T00:00:00Z');
  console.log(`Fetching posts from ${startDate} onwards...\n`);

  let editedCount = 0;
  let checkedCount = 0;

  try {
    // Use getAuthorFeed to get the user's posts
    const res = await agent.app.bsky.feed.getAuthorFeed({
      actor: handle,
      limit: 100, // Max posts to fetch
    });

    for (const feedPost of res.data.feed) {
      const post = feedPost.post as any;
      
      // Check if post is within our date range
      const createdAt = post.record.createdAt;
      const postDate = new Date(createdAt);
      if (postDate < startDateObj) continue;

      checkedCount++;

      if (!post.record.text) continue;

      if (needsCleanup(post.record.text)) {
        const cleaned = cleanText(post.record.text);
        if (cleaned !== post.record.text) {
          const postUri = post.uri;
          const rkey = post.uri.split('/').pop();
          
          console.log(`Deleting post ${postUri}`);
          console.log(`  Original: ${post.record.text.substring(0, 100)}...`);
          console.log(`  Cleaned: ${cleaned.substring(0, 100)}...\n`);

          // Delete the old post using agent.post which has access to com.atproto.repo
          await (agent as any).com.atproto.repo.deleteRecord({
            repo: handle,
            collection: 'app.bsky.feed.post',
            rkey: rkey,
          });

          // Re-post with cleaned text using agent.post convenience method
          await agent.post({
            text: cleaned,
            createdAt: new Date().toISOString(),
          });

          editedCount++;
        }
      }
    }

    console.log(`\nCleanup complete: ${editedCount} posts deleted & reposted, ${checkedCount} posts checked`);
  } catch (err) {
    console.error('Error fetching posts:', err);
    process.exit(1);
  }
}

main().catch(console.error);