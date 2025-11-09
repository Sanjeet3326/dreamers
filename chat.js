document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('chat-input');
  const messages = document.getElementById('messages');
  const chatContainer = document.querySelector('.chat-container');

  // Global error helpers: show runtime errors inline so we can debug quickly
  function showInlineError(msg) {
    try {
      const el = document.createElement('div');
      el.className = 'chat-msg chat-bot';
      el.innerHTML = `<div class="bubble"><strong>Error</strong><div class="msg-text" style="color: #ffb3b3;">${String(msg)}</div></div>`;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    } catch (e) { console.error('Failed to show inline error', e); }
  }

  window.addEventListener('error', (ev) => {
    showInlineError(ev.message || ev.error || 'Unknown error');
    console.error('Captured error:', ev);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    showInlineError((ev.reason && ev.reason.message) || String(ev.reason) || 'Unhandled rejection');
    console.error('Unhandled rejection:', ev);
  });
  
  // Initial greeting
  setTimeout(() => {
    appendMessage(`Hi! I'm your AI assistant. I can answer questions using the content of this website — ask me anything about the site or general topics and I'll use site information when relevant.`, 'bot');
  }, 500);

  // toast notifications removed — no #toast-container in markup

  function showTyping(show = true) {
    // Create typing indicator if it doesn't exist
    let typingIndicator = document.getElementById('typing-indicator');
    if (!typingIndicator) {
      typingIndicator = document.createElement('div');
      typingIndicator.id = 'typing-indicator';
      typingIndicator.className = 'typing-indicator';
      typingIndicator.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
      messages.appendChild(typingIndicator);
    }
    // Use visibility via class so CSS can animate the sliding in/out
    if (show) {
      typingIndicator.classList.add('visible');
      // mark container as answering to trigger input slide
      if (chatContainer) chatContainer.classList.add('answering');
      // ensure we scroll the messages area so typing is visible
      messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
    } else {
      typingIndicator.classList.remove('visible');
      if (chatContainer) chatContainer.classList.remove('answering');
    }
  }

  // When the user asks a question, slide to answering state and show typing
  function slideToAnswering() {
    // scroll to bottom and show typing indicator (which will add 'answering' class)
    messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
    showTyping(true);
  }

  function appendMessage(text, who = 'assistant') {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (who === 'user' ? 'chat-user' : 'chat-bot');
    
    // Format the message text with Markdown-style formatting
    const formattedText = text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/• (.*?)\\n/g, '<br>• $1')
      .replace(/\\n/g, '<br>');
    
    el.innerHTML = `
      <div class="bubble">
        <strong>${who === 'user' ? 'You' : 'AI Assistant'}</strong>
        <div class="msg-text">${formattedText}</div>
      </div>
    `;
    
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  // Enhanced system prompt that understands the website context
  const systemPrompt = {
    role: "system",
    content: `You are a helpful AI assistant that answers questions about any topic. Your responses should be:
    - Clear and informative
    - Based on factual information
    - Easy to understand
    - Professional yet friendly
    
    Focus on providing direct, accurate answers without any reference to managing tasks, goals, or other system features.`
  };

  async function send() {
    const text = (input.value || '').trim();
    if (!text) return;
    
  appendMessage(text, 'user');
  input.value = '';
  // slide UI into answering mode and show typing
  slideToAnswering();

    try {
      const res = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text
        })
      });
      
      showTyping(false);
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('Server error:', errorData);
        if (errorData.error === 'Server missing GOOGLE_API_KEY env variable') {
          appendMessage('The chatbot is not properly configured. Please make sure to set up your API key.', 'bot');
        } else {
          appendMessage('I encountered an error processing your request. Please try again in a moment.', 'bot');
        }
        return;
      }
      
      const data = await res.json();
      if (data.reply) {
        appendMessage(data.reply, 'bot');
        // If the server provided sources, show them as links under the last bot message
        if (data.sources && Array.isArray(data.sources) && data.sources.length) {
          const last = messages.lastElementChild;
          if (last) {
            const srcEl = document.createElement('div');
            srcEl.className = 'msg-sources';
            srcEl.innerHTML = 'Sources: ' + data.sources.map(s => `<a href="${s}" target="_blank" rel="noopener">${s}</a>`).join(', ');
            // append inside the bubble if present
            const bubble = last.querySelector('.bubble');
            if (bubble) bubble.appendChild(srcEl);
          }
        }
      } else {
        appendMessage('I received your message but was unable to generate a proper response. Please try again.', 'bot');
      }
    } catch (err) {
      showTyping(false);
      console.error('Chat error:', err);
      appendMessage('There seems to be a connection issue. Please check if the server is running or try again later.', 'bot');
    }
  }

  // Auto-expand input field
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  });

  // Send button
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', send);
  }

  // Send message on Enter
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Focus input on load
  input.focus();
});
