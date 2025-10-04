/**
 * Enhanced Table Parser with PapaParse Integration
 * This extends the lightweight parser with optional PapaParse for complex CSV files
 */

class EnhancedTableParser extends LightweightTableParser {
  constructor(options = {}) {
    super(options);
    
    this.usePapaParse = options.usePapaParse && typeof Papa !== 'undefined';
    this.papaConfig = {
      header: false,
      skipEmptyLines: true,
      trimHeaders: true,
      dynamicTyping: false,
      ...options.papaConfig
    };
  }
  
  /**
   * Parse CSV with PapaParse (if available) for better performance and features
   * @param {string} data - Raw CSV data
   * @returns {Array<Array<string>>} Parsed table data
   */
  parseCSVWithPapa(data) {
    if (!this.usePapaParse || typeof Papa === 'undefined') {
      return this.parseCSV(data);
    }
    
    try {
      const result = Papa.parse(data, this.papaConfig);
      
      if (result.errors.length > 0) {
        console.warn('CSV parsing warnings:', result.errors);
      }
      
      return result.data.filter(row => 
        row.length > 0 && row.some(cell => cell && cell.trim())
      );
    } catch (error) {
      console.warn('PapaParse failed, falling back to built-in parser:', error);
      return this.parseCSV(data);
    }
  }
  
  /**
   * Enhanced auto-detect with PapaParse support
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
      // Use PapaParse if available for CSV
      return this.parseCSVWithPapa(data);
    }
    
    return [];
  }
  
  /**
   * Parse large files in chunks to prevent UI blocking
   * @param {string} data - Raw table data
   * @param {Object} options - Parsing options
   * @returns {Promise<Array<Array<string>>>} Parsed table data
   */
  async parseAsync(data, options = {}) {
    const { chunkSize = 1000, format = 'auto' } = options;
    
    return new Promise((resolve, reject) => {
      try {
        let result;
        
        if (data.length > chunkSize && this.usePapaParse && format === 'csv') {
          // Use PapaParse streaming for large CSV files
          Papa.parse(data, {
            ...this.papaConfig,
            chunk: (results) => {
              // Process chunk
              console.log('Processing chunk:', results.data.length, 'rows');
            },
            complete: (results) => {
              resolve(results.data);
            },
            error: (error) => {
              console.warn('Async parsing failed, falling back to sync:', error);
              resolve(this.parseAuto(data));
            }
          });
        } else {
          // Use standard parsing
          result = this.parseAuto(data);
          resolve(result);
        }
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Convert to different output formats
   * @param {Array<Array<string>>} tableData - Parsed table data
   * @param {string} format - Output format (html, json, csv)
   * @param {Object} options - Conversion options
   * @returns {string|Array} Converted data
   */
  convert(tableData, format = 'html', options = {}) {
    switch (format.toLowerCase()) {
      case 'json':
        return this.toJSON(tableData, options);
      case 'csv':
        return this.toCSV(tableData, options);
      case 'html':
      default:
        return this.toHTML(tableData, options);
    }
  }
  
  /**
   * Convert parsed table data back to CSV
   * @param {Array<Array<string>>} tableData - Parsed table data
   * @param {Object} options - Conversion options
   * @returns {string} CSV string
   */
  toCSV(tableData, options = {}) {
    if (!Array.isArray(tableData) || tableData.length === 0) return '';
    
    const { delimiter = ',', quote = '"', escape = '"' } = options;
    
    return tableData.map(row => {
      return row.map(cell => {
        const stringCell = String(cell || '');
        
        // Check if cell needs quoting
        if (stringCell.includes(delimiter) || stringCell.includes(quote) || stringCell.includes('\n')) {
          // Escape quotes and wrap in quotes
          const escapedCell = stringCell.replace(new RegExp(quote, 'g'), escape + quote);
          return quote + escapedCell + quote;
        }
        
        return stringCell;
      }).join(delimiter);
    }).join('\n');
  }
  
  /**
   * Get parsing statistics
   * @param {string} data - Raw table data
   * @returns {Object} Parsing statistics
   */
  getStats(data) {
    if (!data) return { rows: 0, columns: 0, size: 0, format: 'unknown' };
    
    const lines = data.split('\n');
    const size = data.length;
    
    let format = 'unknown';
    if (data.includes('<table')) format = 'html';
    else if (data.includes('|') && lines.some(line => line.trim().startsWith('|'))) format = 'markdown';
    else if (data.includes(',')) format = 'csv';
    else if (data.includes('\t')) format = 'tsv';
    
    try {
      const parsed = this.parseAuto(data);
      return {
        rows: parsed.length,
        columns: parsed[0]?.length || 0,
        size: size,
        format: format,
        sizeFormatted: this._formatBytes(size)
      };
    } catch (error) {
      return {
        rows: 0,
        columns: 0,
        size: size,
        format: format,
        error: error.message,
        sizeFormatted: this._formatBytes(size)
      };
    }
  }
  
  /**
   * Format bytes to human readable string
   * @private
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

// Export enhanced parser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EnhancedTableParser;
} else if (typeof window !== 'undefined') {
  window.EnhancedTableParser = EnhancedTableParser;
}