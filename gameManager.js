const words = require('./words.json');
const axios = require('axios');

class GameManager {
  constructor() {
    this.players = {}; // { username: score }
    this.usedWords = new Set();
    this.round = 0;
    this.maxRounds = 10;
    this.started = false;
    this.currentFirstLetter = '';
    this.currentLastLetter = '';
  }

  startGame() {
    this.started = true;
    this.round = 1;
    this.usedWords.clear();
    this.currentFirstLetter = this.randomLetter();
    this.currentLastLetter = this.randomLetter();
  }

  startNewRound() {
    this.usedWords.clear();
    this.currentFirstLetter = this.randomLetter();
    this.currentLastLetter = this.randomLetter();
  }

  async submitWord(username, word) {
    console.log('DEBUG HARFLER:', this.currentFirstLetter, this.currentLastLetter, 'KELİME:', word);
    word = word.toLowerCase();
    const valid =
      word.startsWith(this.currentFirstLetter) &&
      word.endsWith(this.currentLastLetter) &&
      !this.usedWords.has(word);

    if (this.players[username] === undefined) this.players[username] = 0;

    let isValidWord = false;
    if (valid) {
      try {
        const res = await axios.get(
          `https://sozluk.gov.tr/gts?ara=${encodeURIComponent(word)}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://sozluk.gov.tr/'
            },
            timeout: 4000
          }
        );
        const data = res.data;
        console.log('TDK API:', data);
        isValidWord = Array.isArray(data) && data.length > 0 && !data[0].error;
      } catch (e) {
        console.error('TDK API hatası:', e);
      }
    }

    let puan = 0;
    if (valid && isValidWord) {
      puan = word.length;
      this.players[username] += puan;
      this.usedWords.add(word);
      console.log('PUAN ARTTI:', username, this.players[username]);
    } else {
      puan = 0;
      console.log('PUAN ARTMADI:', { valid, word, isValidWord });
    }

    const roundOver = false; // Artık submitWord ile round bitmiyor
    const gameOver = this.round >= this.maxRounds;

    // Harf ve round sadece zamanlayıcı ile değişecek

    return {
      username,
      word,
      valid,
      puan,
      round: this.round,
      roundOver,
      gameOver,
      scores: this.players,
      nextLetters: [this.currentFirstLetter, this.currentLastLetter]
    }
  }

  getState() {
    return {
      round: this.round,
      maxRounds: this.maxRounds,
      scores: this.players,
      usedWords: [...this.usedWords],
      currentFirstLetter: this.currentFirstLetter,
      currentLastLetter: this.currentLastLetter
    };
  }

  randomLetter() {
    const letters = 'abcçdefghıijklmnoprstuüvyz';
    return letters[Math.floor(Math.random() * letters.length)];
  }
}

module.exports = GameManager;