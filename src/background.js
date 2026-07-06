// Background service worker for Chrome extension
console.log('Splunk Detokenizer Background Script loaded');

// Cache configuration
const CACHE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_ENTRIES = 100; // Prevent unlimited growth

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background received message:', request);

  if (request.action === 'detokenize') {
    console.log('Processing detokenize request for token:', request.token?.substring(0, 10) + '...');

    // Handle async operation
    handleDetokenize(request.token)
      .then(result => {
        console.log('Detokenization complete, sending response:', result);
        sendResponse(result);
      })
      .catch(error => {
        console.error('Detokenization error:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true; // Keep message channel open for async response
  }

  return false;
});

// Main detokenization handler
async function handleDetokenize(token) {
  try {
    console.log('Starting detokenization for token:', token.substring(0, 10) + '...');

    // Check cache first
    const cachedResult = await getCachedResult(token);
    if (cachedResult) {
      console.log('✅ Cache hit! Returning cached result:', cachedResult.substring(0, 50) + '...');
      return {
        success: true,
        detokenizedValue: cachedResult,
        fromCache: true
      };
    }

    console.log('Cache miss, proceeding with detokenization...');

    // Open BlackTab page and automate it
    const result = await automateBlackTab(token);

    // Cache the successful result
    await cacheResult(token, result);
    console.log('✅ Result cached for future use');

    return {
      success: true,
      detokenizedValue: result
    };

  } catch (error) {
    console.error('Detokenization failed:', error);

    // Check if error is authentication-related
    if (error.message && error.message.includes('Insufficient Privileges')) {
      return {
        success: false,
        error: 'Not authenticated to Salesforce. Please login to bt1.my.salesforce.com and try again.'
      };
    }

    return {
      success: false,
      error: error.message
    };
  }
}

// Get cached result if available and not expired
async function getCachedResult(token) {
  try {
    const result = await chrome.storage.local.get(['detokenCache']);
    const cache = result.detokenCache || {};

    const entry = cache[token];
    if (!entry) {
      return null;
    }

    // Check if expired
    const now = Date.now();
    if (now - entry.timestamp > CACHE_EXPIRY_MS) {
      console.log('Cache entry expired, removing...');
      delete cache[token];
      await chrome.storage.local.set({ detokenCache: cache });
      return null;
    }

    return entry.value;
  } catch (error) {
    console.error('Error reading cache:', error);
    return null;
  }
}

// Cache a detokenization result
async function cacheResult(token, value) {
  try {
    const result = await chrome.storage.local.get(['detokenCache']);
    let cache = result.detokenCache || {};

    // Add new entry
    cache[token] = {
      value: value,
      timestamp: Date.now()
    };

    // Enforce max cache size (LRU: remove oldest entries)
    const entries = Object.entries(cache);
    if (entries.length > MAX_CACHE_ENTRIES) {
      // Sort by timestamp (oldest first)
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

      // Keep only the newest MAX_CACHE_ENTRIES
      const entriesToKeep = entries.slice(-MAX_CACHE_ENTRIES);
      cache = Object.fromEntries(entriesToKeep);

      console.log(`Cache pruned from ${entries.length} to ${MAX_CACHE_ENTRIES} entries`);
    }

    await chrome.storage.local.set({ detokenCache: cache });
  } catch (error) {
    console.error('Error caching result:', error);
  }
}

// Automate BlackTab page - FAST direct POST (no tab needed!)
async function automateBlackTab(token) {
  console.log('🚀 Starting FAST detokenization via direct POST...');

  try {
    // Try fast method first (direct POST)
    return await fastDetokenize(token);
  } catch (error) {
    console.log('ℹ️ Fast method not available, using tab method...');
    // Fallback to old tab method if fast method fails
    return await slowDetokenizeWithTab(token);
  }
}

// FAST METHOD - Direct POST request (< 2 seconds)
async function fastDetokenize(token) {
  console.log('Making direct POST request to BlackTab...');

  const url = 'https://bt1.my.salesforce.com/admin/gdpr-tokenizer/tokenizer.apexp';

  // Build form data (exact same as the form submit)
  const formData = new URLSearchParams({
    'tokenizerBT:tokenizerForm': 'tokenizerBT:tokenizerForm',
    'tokenizerBT:tokenizerForm:operationType': 'd',  // d = detokenize
    'tokenizerBT:tokenizerForm:orgId': '',
    'tokenizerBT:tokenizerForm:linkedEntityId': '',
    'tokenizerBT:tokenizerForm:userIdGeneralToken': '',
    'tokenizerBT:tokenizerForm:token': token,
    'tokenizerBT:tokenizerForm:performAction': 'Perform Operation'
  });

  console.log('Sending POST request with body:', formData.toString().substring(0, 200) + '...');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
    credentials: 'include'  // Include cookies for authentication
  });

  console.log('Response status:', response.status, response.statusText);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Response error body:', errorText.substring(0, 500));
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  console.log('✅ Response received, parsing HTML...');

  const html = await response.text();
  console.log('HTML length:', html.length);

  // Try multiple patterns to extract the result

  // Pattern 1: Look for <b>Data: </b>value in the HTML
  let dataMatch = html.match(/<b>Data:\s*<\/b>([^<]+)/i);
  if (dataMatch && dataMatch[1]) {
    const result = dataMatch[1].trim();
    console.log('✅ SUCCESS (Pattern 1)! Detokenized value:', result.substring(0, 50) + '...');
    return result;
  }

  // Pattern 2: Look for the textarea with the result
  // Format: <textarea id="tokenizerBT:tokenizerForm:token" ...>RESULT_HERE</textarea>
  const textareaMatch = html.match(/<textarea[^>]*id="tokenizerBT:tokenizerForm:token"[^>]*>(.*?)<\/textarea>/is);
  if (textareaMatch && textareaMatch[1]) {
    const result = textareaMatch[1].trim();
    if (result && result.length > 0) {
      console.log('✅ SUCCESS (Pattern 2)! Detokenized value:', result.substring(0, 50) + '...');
      return result;
    }
  }

  // Pattern 3: Look for any textarea containing the result
  const anyTextareaMatch = html.match(/<textarea[^>]*>(.*?)<\/textarea>/is);
  if (anyTextareaMatch && anyTextareaMatch[1]) {
    const result = anyTextareaMatch[1].trim();
    if (result && result.length > 10) {  // Reasonable length
      console.log('✅ SUCCESS (Pattern 3)! Detokenized value:', result.substring(0, 50) + '...');
      return result;
    }
  }

  // Check for error messages
  const errorMatch = html.match(/<font[^>]*color\s*=\s*["']red["'][^>]*>([^<]+)/i);
  if (errorMatch && errorMatch[1]) {
    console.error('Error from BlackTab:', errorMatch[1]);
    throw new Error(errorMatch[1].trim());
  }

  // If we still can't find it, log and throw
  console.error('Could not find result in HTML with any pattern');
  console.log('HTML snippet (first 1000 chars):', html.substring(0, 1000));
  console.log('Searching for textarea in HTML:', html.includes('textarea') ? 'Found' : 'Not found');

  throw new Error('Could not find result in response HTML. Falling back to tab method.');
}

// SLOW METHOD - Fallback using tab (10-15 seconds)
async function slowDetokenizeWithTab(token) {
  const url = 'https://bt1.my.salesforce.com/admin/gdpr-tokenizer/tokenizer.apexp';

  return new Promise((resolve, reject) => {
    console.log('Opening BlackTab page in background tab...');

    // Create tab in background (will be visible in tab bar but inactive)
    chrome.tabs.create({ url: url, active: false }, async (tab) => {
      const tabId = tab.id;
      console.log('Background tab created:', tabId);

      try {
        // Wait for tab to load (handles login redirects)
        console.log('Waiting for tokenizer page to load (this may take time if you need to login)...');
        await waitForTabComplete(tabId);
        console.log('✅ Tokenizer page loaded successfully!');

        // Get current URL to confirm we're on the right page
        const currentTab = await chrome.tabs.get(tabId);
        console.log('Current URL:', currentTab.url);

        if (!currentTab.url.includes('/admin/gdpr-tokenizer/tokenizer.apexp')) {
          throw new Error('Not on tokenizer page. Current URL: ' + currentTab.url);
        }

        // Check if we're on a redirect page
        const isRedirectPage = currentTab.url.includes('?ec=') ||
                               currentTab.url.includes('&startURL=') ||
                               currentTab.url.includes('/secur/frontdoor') ||
                               currentTab.url.includes('/saml/') ||
                               currentTab.url.includes('/idp/');

        if (isRedirectPage) {
          throw new Error('Still on redirect/auth page. Current URL: ' + currentTab.url);
        }

        // Wait for page to initialize (optimized)
        await sleep(2000);
        console.log('Page initialized, inspecting page structure...');

        // First, inspect the page to understand its structure
        const inspectResult = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: () => {
            console.log('=== PAGE INSPECTION ===');

            // Get all form elements
            const forms = document.querySelectorAll('form');
            console.log('Forms:', forms.length);

            const selects = document.querySelectorAll('select');
            console.log('Selects:', selects.length);
            selects.forEach((sel, i) => {
              console.log(`  Select [${i}]:`, sel.id, sel.name, 'Value:', sel.value);
              const opts = sel.querySelectorAll('option');
              opts.forEach(opt => {
                console.log(`    Option:`, opt.value, '=', opt.textContent, 'Selected:', opt.selected);
              });
            });

            const textareas = document.querySelectorAll('textarea');
            console.log('Textareas:', textareas.length);
            textareas.forEach((ta, i) => {
              console.log(`  Textarea [${i}]:`, ta.id, ta.name, ta.placeholder);
            });

            const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
            console.log('Buttons:', buttons.length);
            buttons.forEach((btn, i) => {
              console.log(`  Button [${i}]:`, btn.textContent || btn.value, 'Type:', btn.type);
            });

            return {
              forms: forms.length,
              selects: selects.length,
              textareas: textareas.length,
              buttons: buttons.length
            };
          }
        });

        console.log('Page inspection result:', inspectResult?.[0]?.result);

        // Verify we have the necessary elements
        const pageInfo = inspectResult?.[0]?.result;
        if (!pageInfo || pageInfo.textareas === 0 || pageInfo.buttons === 0) {
          console.error('❌ Page does not have expected elements!');
          console.error('Expected: textareas > 0 and buttons > 0');
          console.error('Found:', pageInfo);

          // Wait a bit longer and try again
          console.log('Waiting 3 more seconds for page to load...');
          await sleep(3000);

          // Re-inspect
          const retryInspect = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
              return {
                forms: document.querySelectorAll('form').length,
                textareas: document.querySelectorAll('textarea').length,
                buttons: document.querySelectorAll('button, input[type="submit"], input[type="button"]').length
              };
            }
          });

          console.log('Retry inspection result:', retryInspect?.[0]?.result);

          if (!retryInspect?.[0]?.result || retryInspect[0].result.textareas === 0) {
            throw new Error('Page does not have tokenizer form. Still on redirect/login page?');
          }
        }

        // Now fill the token in the CORRECT textarea
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: (tokenValue) => {
            console.log('=== FILLING TOKEN ===');
            console.log('Token:', tokenValue.substring(0, 20) + '...');

            // Find the correct textarea by checking for "token" in ID or name
            const textareas = document.querySelectorAll('textarea');
            let tokenField = null;

            for (let ta of textareas) {
              const id = (ta.id || '').toLowerCase();
              const name = (ta.name || '').toLowerCase();
              console.log('Checking textarea:', ta.id, ta.name);

              if (id.includes('token') || name.includes('token')) {
                tokenField = ta;
                console.log('Found token textarea:', ta.id, ta.name);
                break;
              }
            }

            if (!tokenField) {
              console.error('Could not find token textarea');
              return false;
            }

            // Fill the token
            tokenField.value = tokenValue;
            tokenField.focus();

            // Trigger all possible events
            tokenField.dispatchEvent(new Event('input', { bubbles: true }));
            tokenField.dispatchEvent(new Event('change', { bubbles: true }));
            tokenField.dispatchEvent(new Event('keyup', { bubbles: true }));
            tokenField.dispatchEvent(new Event('blur', { bubbles: true }));

            console.log('Token filled successfully!');
            console.log('Textarea ID:', tokenField.id);
            console.log('Textarea value:', tokenField.value.substring(0, 20) + '...');
            return true;
          },
          args: [token]
        });

        console.log('Token filled, waiting 1 second...');
        await sleep(1000);

        // Click the perform button with detailed logging
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: () => {
            console.log('=== CLICKING BUTTON ===');

            const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
            console.log('Found', buttons.length, 'buttons');

            for (let i = 0; i < buttons.length; i++) {
              const btn = buttons[i];
              const text = (btn.textContent || btn.value || '').toLowerCase();
              console.log(`  Button [${i}]:`, btn.textContent || btn.value);

              if (text.includes('perform')) {
                console.log('Clicking button:', btn.textContent || btn.value);
                console.log('Button type:', btn.type);
                console.log('Button disabled?', btn.disabled);

                // Try clicking with different methods
                btn.focus();
                btn.click();

                // Also try triggering click event manually
                btn.dispatchEvent(new MouseEvent('click', {
                  view: window,
                  bubbles: true,
                  cancelable: true
                }));

                console.log('Button clicked!');
                return true;
              }
            }

            console.error('No perform button found');
            return false;
          }
        });

        console.log('Button clicked, waiting for result...');

        // Wait for result to appear (optimized from 8000ms)
        await sleep(4000);

        // Extract result or error
        const resultScript = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: (inputToken) => {
            console.log('Extracting result...');

            // Get all text content
            const bodyText = document.body.textContent || document.body.innerText || '';
            console.log('Page text (first 500 chars):', bodyText.substring(0, 500));

            // Check for error messages first
            if (bodyText.includes('INVALID_TOKEN')) {
              console.log('Found error: INVALID_TOKEN');
              return { error: 'Invalid token format. Please check the token and try again.' };
            }

            if (bodyText.includes('Insufficient Privileges') || bodyText.includes('not allowed')) {
              const errorMatch = bodyText.match(/(Insufficient Privileges[^.]*\.)/i) ||
                                bodyText.match(/(You are not allowed[^.]*\.)/i);
              if (errorMatch) {
                console.log('Found error:', errorMatch[0]);
                return { error: errorMatch[0] };
              }
              return { error: 'You are not allowed to detokenize that token.' };
            }

            // Check for other common error patterns
            if (bodyText.includes('Error:') || bodyText.includes('ERROR')) {
              const errorMatch = bodyText.match(/(?:Error:|ERROR)[:\s]*([^\n]+)/i);
              if (errorMatch && errorMatch[1]) {
                const errorMsg = errorMatch[1].trim();
                console.log('Found error:', errorMsg);
                return { error: errorMsg };
              }
            }

            // Check for "Data:" pattern (BlackTab result format)
            if (bodyText.includes('Data:')) {
              const dataMatch = bodyText.match(/Data:\s*(.+?)(?:\n|$)/i);
              if (dataMatch && dataMatch[1]) {
                const result = dataMatch[1].trim();
                console.log('Found result with Data: pattern:', result);
                return { value: result };
              }
            }

            // Look for result in divs/spans with specific text patterns
            const allElements = document.querySelectorAll('div, span, p, pre, code');
            for (let el of allElements) {
              const text = el.textContent.trim();
              if (text.startsWith('Data:')) {
                const result = text.replace(/^Data:\s*/i, '').trim();
                if (result && result.length > 0) {
                  console.log('Found result in element:', result);
                  return { value: result };
                }
              }
            }

            // Look for result in the token textarea specifically
            const textareas = document.querySelectorAll('textarea');
            console.log('Checking', textareas.length, 'textareas');

            let tokenTextarea = null;
            for (let ta of textareas) {
              const id = (ta.id || '').toLowerCase();
              const name = (ta.name || '').toLowerCase();
              if (id.includes('token') || name.includes('token')) {
                tokenTextarea = ta;
                break;
              }
            }

            if (tokenTextarea) {
              const val = tokenTextarea.value.trim();
              console.log('Token textarea value:', val.substring(0, 100));
              if (val && val !== inputToken && val.length > 0) {
                console.log('Found result in token textarea:', val);
                return { value: val };
              }
            }

            // Also check all textareas as fallback
            for (let i = 0; i < textareas.length; i++) {
              const ta = textareas[i];
              const val = ta.value.trim();
              console.log(`  Textarea [${i}] (${ta.id}):`, val.substring(0, 50));
              if (val && val !== inputToken && val.length > 0 && !ta.id.includes('justification')) {
                console.log('Found result in textarea:', val);
                return { value: val };
              }
            }

            // Look in all text inputs
            const inputs = document.querySelectorAll('input[type="text"]');
            console.log('Checking', inputs.length, 'text inputs');
            for (let i = 0; i < inputs.length; i++) {
              const inp = inputs[i];
              const val = inp.value.trim();
              console.log(`  Input [${i}]:`, val.substring(0, 100));
              if (val && val !== inputToken && val.length > 0) {
                console.log('Found result in input:', val);
                return { value: val };
              }
            }

            console.log('No result found yet');
            return null;
          },
          args: [token]
        });

        console.log('Result extraction complete:', resultScript);

        const result = resultScript?.[0]?.result;

        // Check if we got an error
        if (result && result.error) {
          console.error('BlackTab returned error:', result.error);
          // Close tab immediately on error
          chrome.tabs.remove(tabId).catch(() => {});
          reject(new Error(result.error));
          return;
        }

        // Check if we got a value
        if (result && result.value) {
          console.log('SUCCESS! Detokenized value:', result.value);
          // Close tab immediately
          chrome.tabs.remove(tabId).catch(() => {});
          resolve(result.value);
          return;
        }

        // No result yet, try again
        console.log('No result found, waiting 3 more seconds...');

        setTimeout(async () => {
          const retryScript = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (inputToken) => {
              console.log('Retry: Extracting result...');

              // Check for errors
              const bodyText = document.body.textContent || document.body.innerText || '';

              if (bodyText.includes('Insufficient Privileges') || bodyText.includes('not allowed')) {
                const errorMatch = bodyText.match(/(Insufficient Privileges[^.]*\.)/i) ||
                                  bodyText.match(/(You are not allowed[^.]*\.)/i);
                if (errorMatch) {
                  return { error: errorMatch[0] };
                }
                return { error: 'You are not allowed to detokenize that token.' };
              }

              // Check for "Data:" pattern
              if (bodyText.includes('Data:')) {
                const dataMatch = bodyText.match(/Data:\s*(.+?)(?:\n|$)/i);
                if (dataMatch && dataMatch[1]) {
                  const result = dataMatch[1].trim();
                  console.log('Retry: Found result with Data: pattern:', result);
                  return { value: result };
                }
              }

              // Look in elements
              const allElements = document.querySelectorAll('div, span, p, pre, code');
              for (let el of allElements) {
                const text = el.textContent.trim();
                if (text.startsWith('Data:')) {
                  const result = text.replace(/^Data:\s*/i, '').trim();
                  if (result && result.length > 0) {
                    console.log('Retry: Found result in element:', result);
                    return { value: result };
                  }
                }
              }

              // Check the token textarea specifically
              const textareas = document.querySelectorAll('textarea');
              let tokenTextarea = null;
              for (let ta of textareas) {
                const id = (ta.id || '').toLowerCase();
                const name = (ta.name || '').toLowerCase();
                if (id.includes('token') || name.includes('token')) {
                  tokenTextarea = ta;
                  break;
                }
              }

              if (tokenTextarea) {
                const val = tokenTextarea.value.trim();
                if (val && val !== inputToken && val.length > 0) {
                  console.log('Retry: Found result in token textarea:', val);
                  return { value: val };
                }
              }

              // Fallback: check all textareas except justification fields
              for (let ta of textareas) {
                const val = ta.value.trim();
                const id = (ta.id || '').toLowerCase();
                if (val && val !== inputToken && val.length > 0 && !id.includes('justification')) {
                  console.log('Retry: Found result in textarea:', val);
                  return { value: val };
                }
              }

              // Check inputs
              const inputs = document.querySelectorAll('input[type="text"]');
              for (let inp of inputs) {
                const val = inp.value.trim();
                if (val && val !== inputToken && val.length > 0) {
                  console.log('Retry: Found result in input:', val);
                  return { value: val };
                }
              }

              return null;
            },
            args: [token]
          });

          const retryResult = retryScript?.[0]?.result;

          if (retryResult && retryResult.error) {
            console.error('BlackTab returned error on retry:', retryResult.error);
            chrome.tabs.remove(tabId).catch(() => {});
            reject(new Error(retryResult.error));
          } else if (retryResult && retryResult.value) {
            console.log('SUCCESS on retry! Value:', retryResult.value);
            chrome.tabs.remove(tabId).catch(() => {});
            resolve(retryResult.value);
          } else {
            chrome.tabs.remove(tabId).catch(() => {});
            reject(new Error('Timeout: No result after 8.5 seconds. Check extension logs for details.'));
          }
        }, 3000);

      } catch (error) {
        console.error('Error during automation:', error);
        chrome.windows.remove(windowId).catch(() => {});
        reject(error);
      }
    });
  });
}

// Wait for tab to load the correct page (not login/redirect pages)
function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    // Increase timeout to 2 minutes to give user time to login
    const timeout = setTimeout(() => {
      reject(new Error('Tab load timeout after 2 minutes. Please ensure you are logged into bt1.my.salesforce.com'));
    }, 120000);

    let lastCheckTime = Date.now();

    async function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;

      // Check on every status update
      if (changeInfo.status === 'complete' || changeInfo.url) {
        const now = Date.now();

        // Throttle checks to avoid rapid fire (wait at least 1 second between checks)
        if (now - lastCheckTime < 1000) {
          return;
        }
        lastCheckTime = now;

        try {
          // Get current tab info
          const currentTab = await chrome.tabs.get(tabId);
          const url = currentTab.url;

          console.log('Tab status:', changeInfo.status, 'URL:', url);

          // Check if we're on the actual tokenizer page (not login/redirect)
          // The correct URL is: https://bt1.my.salesforce.com/admin/gdpr-tokenizer/tokenizer.apexp
          const isTokenizerPage = url && url.includes('/admin/gdpr-tokenizer/tokenizer.apexp');

          // All known redirect/auth URLs
          const isRedirect = url && (
            url.includes('?ec=') ||           // Salesforce redirect
            url.includes('&startURL=') ||     // Salesforce start URL param
            url.includes('&retURL=') ||       // Salesforce return URL param
            url.includes('/idp/') ||          // Identity provider
            url.includes('/saml/') ||         // SAML auth
            url.includes('/secur/frontdoor') || // Salesforce SSO frontdoor
            url.includes('central.my.salesforce.com') || // Central SSO
            url.includes('login') ||          // Login pages
            url.includes('authn-request')     // Auth request pages
          );

          if (isTokenizerPage && !isRedirect && changeInfo.status === 'complete') {
            console.log('✅ Tokenizer page loaded and complete!');
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);

            // Give page a moment to fully initialize
            setTimeout(() => resolve(), 2000);
          } else if (isRedirect) {
            console.log('⏳ On login/auth/redirect page, waiting...', url.substring(0, 150));
            // Keep waiting - user needs to login or page needs to redirect
          } else if (isTokenizerPage && isRedirect) {
            console.log('⏳ On tokenizer redirect page, waiting for actual page...', url.substring(0, 150));
            // Still on redirect, keep waiting
          } else if (changeInfo.status === 'complete' && url) {
            console.log('⚠️ Page loaded but URL not recognized:', url.substring(0, 150));
            // Log unrecognized URLs for debugging
          }
        } catch (error) {
          console.error('Error checking tab:', error);
        }
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Sleep utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { action: 'openPanel' }).catch(() => {});
});

// Context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'detokenize-selection',
    title: 'Detokenize with BlackTab',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'clear-cache',
    title: 'Clear Detokenization Cache',
    contexts: ['page', 'action']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'detokenize-selection') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'openPanel',
      token: info.selectionText
    }).catch(() => {});
  } else if (info.menuItemId === 'clear-cache') {
    try {
      const result = await chrome.storage.local.get(['detokenCache']);
      const cache = result.detokenCache || {};
      const count = Object.keys(cache).length;

      await chrome.storage.local.set({ detokenCache: {} });
      console.log(`✅ Cache cleared! Removed ${count} entries.`);

      // Notify user
      chrome.tabs.sendMessage(tab.id, {
        action: 'showNotification',
        message: `Cache cleared! Removed ${count} cached tokens.`,
        type: 'info'
      }).catch(() => {
        // If content script not available, just log
        console.log('Cache cleared but could not show notification (content script not loaded)');
      });
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }
});
