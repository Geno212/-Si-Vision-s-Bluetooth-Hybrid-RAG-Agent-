/**
 * Lightweight Table Parser Library
 * Optimized for performance and minimal bundle size
 * Supports: CSV, TSV, Markdown tables, and HTML tables
 */

class LightweightTableParser {
  constructor(options = {}) {
    this.options = {
      delimiter: ',',
      quote: '"',
      escape: '"',
      trimWhitespace: true,
      skipEmptyLines: true,
      headerRow: true,
      maxRows: 10000, // Prevent memory issues
      ...options
    };
  }

  /**
   * Parse CSV/TSV data
   * @param {string} data - Raw CSV/TSV data
   * @returns {Array<Array<string>>} Parsed table data
   */
  parseCSV(data) {
    if (!data || typeof data !== 'string') return [];
    
    const lines = data.split(/\r\n|\n|\r/);
    const result = [];
    const { delimiter, quote, trimWhitespace, skipEmptyLines, maxRows } = this.options;
    
    let rowCount = 0;
    
    for (const line of lines) {
      if (rowCount >= maxRows) break;
      
      const trimmedLine = trimWhitespace ? line.trim() : line;
      if (skipEmptyLines && !trimmedLine) continue;
      
      const row = this._parseCSVLine(trimmedLine, delimiter, quote);
      if (row.length > 0) {
        result.push(row);
        rowCount++;
      }
    }
    
    return result;
  }

  /**
   * Parse markdown table data
   * @param {string} data - Raw markdown table data
   * @returns {Array<Array<string>>} Parsed table data
   */
  parseMarkdown(data) {
    if (!data || typeof data !== 'string') return [];
    
    const lines = data.split(/\r\n|\n|\r/);
    const result = [];
    const { trimWhitespace, skipEmptyLines, maxRows } = this.options;
    
    let rowCount = 0;
    
    for (const line of lines) {
      if (rowCount >= maxRows) break;
      
      const trimmedLine = trimWhitespace ? line.trim() : line;
      if (skipEmptyLines && !trimmedLine) continue;
      
      // Check if it's a table row (contains pipes)
      if (trimmedLine.includes('|')) {
        // Skip separator rows (contains only |, -, :, and spaces)
        if (/^\|[\s\-:|]+\|$/.test(trimmedLine)) continue;
        
        const row = this._parseMarkdownLine(trimmedLine);
        if (row.length > 0) {
          result.push(row);
          rowCount++;
        }
      }
    }
    
    return result;
  }

  /**
   * Parse HTML table data
   * @param {string} html - HTML string containing table
   * @returns {Array<Array<string>>} Parsed table data
   */
  parseHTML(html) {
    if (!html || typeof html !== 'string') return [];
    
    // Simple regex-based HTML table parser (lightweight alternative to DOM parsing)
    const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) return [];
    
    const tableContent = tableMatch[1];
    const rowMatches = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    if (!rowMatches) return [];
    
    const result = [];
    const { maxRows } = this.options;
    
    for (let i = 0; i < Math.min(rowMatches.length, maxRows); i++) {
      const rowContent = rowMatches[i];
      const cellMatches = rowContent.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi);
      
      if (cellMatches) {
        const row = cellMatches.map(cell => {
          // Remove HTML tags and decode entities
          return this._cleanHTMLCell(cell);
        });
        result.push(row);
      }
    }
    
    return result;
  }

  /**
   * Auto-detect and parse table format
   * @param {string} data - Raw table data
   * @returns {Array<Array<string>>} Parsed table data
   */
  parseAuto(data) {
    if (!data || typeof data !== 'string') return [];
    
    // Detect format based on content
    if (data.includes('<table')) {
      return this.parseHTML(data);
    } else if (data.includes('|') && data.split('\n').some(line => line.trim().startsWith('|'))) {
      return this.parseMarkdown(data);
    } else if (data.includes(',') || data.includes('\t')) {
      // Try CSV first, then TSV
      const csvResult = this.parseCSV(data);
      if (csvResult.length > 0) return csvResult;
      
      // Try TSV
      const tsvParser = new LightweightTableParser({ ...this.options, delimiter: '\t' });
      return tsvParser.parseCSV(data);
    }
    
    return [];
  }

  /**
   * Convert parsed table data to HTML
   * @param {Array<Array<string>>} tableData - Parsed table data
   * @param {Object} options - Rendering options
   * @returns {string} HTML table string
   */
  toHTML(tableData, options = {}) {
    if (!Array.isArray(tableData) || tableData.length === 0) return '';
    
    const {
      className = 'lightweight-table',
      headerRow = this.options.headerRow,
      stripHTML = true
    } = options;
    
    let html = `<table class="${className}">`;
    
    tableData.forEach((row, rowIndex) => {
      const isHeader = headerRow && rowIndex === 0;
      const cellTag = isHeader ? 'th' : 'td';
      
      html += '<tr>';
      row.forEach(cell => {
        const cleanCell = stripHTML ? this._stripHTML(cell) : cell;
        const escapedCell = this._escapeHTML(cleanCell);
        html += `<${cellTag}>${escapedCell}</${cellTag}>`;
      });
      html += '</tr>';
    });
    
    html += '</table>';
    return html;
  }

  /**
   * Convert parsed table data to JSON
   * @param {Array<Array<string>>} tableData - Parsed table data
   * @param {Object} options - Conversion options
   * @returns {Array<Object>} JSON array
   */
  toJSON(tableData, options = {}) {
    if (!Array.isArray(tableData) || tableData.length === 0) return [];
    
    const { headerRow = this.options.headerRow } = options;
    
    if (!headerRow || tableData.length < 2) {
      // No headers, return array of arrays
      return tableData.map((row, index) => ({ row: index, data: row }));
    }
    
    const headers = tableData[0];
    const dataRows = tableData.slice(1);
    
    return dataRows.map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || '';
      });
      return obj;
    });
  }

  // Private helper methods
  _parseCSVLine(line, delimiter, quote) {
    const result = [];
    let current = '';
    let inQuotes = false;
    let i = 0;
    
    while (i < line.length) {
      const char = line[i];
      const nextChar = line[i + 1];
      
      if (char === quote) {
        if (inQuotes && nextChar === quote) {
          // Escaped quote
          current += quote;
          i += 2;
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
          i++;
        }
      } else if (char === delimiter && !inQuotes) {
        // End of field
        result.push(this.options.trimWhitespace ? current.trim() : current);
        current = '';
        i++;
      } else {
        current += char;
        i++;
      }
    }
    
    // Add final field
    result.push(this.options.trimWhitespace ? current.trim() : current);
    return result;
  }

  _parseMarkdownLine(line) {
    // Remove leading and trailing pipes
    const cleaned = line.replace(/^\||\|$/g, '');
    const cells = cleaned.split('|');
    
    return cells.map(cell => {
      return this.options.trimWhitespace ? cell.trim() : cell;
    });
  }

  _cleanHTMLCell(cellHTML) {
    // Remove HTML tags
    let text = cellHTML.replace(/<[^>]*>/g, '');
    
    // Decode common HTML entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
    
    return this.options.trimWhitespace ? text.trim() : text;
  }

  _stripHTML(text) {
    return text.replace(/<[^>]*>/g, '');
  }

  _escapeHTML(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LightweightTableParser;
} else if (typeof window !== 'undefined') {
  window.LightweightTableParser = LightweightTableParser;
}