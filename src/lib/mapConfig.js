export const mapConfig = {
  image: {
    url: '/maps/yard-satellite.png',
    width: 3024,
    height: 1720,
    name: 'Satellite'
  },
  vectorLayers: [
    {
      id: 'paths-structures',
      name: 'Paths & structures'
    }
  ],
  statuses: [
    { value: 'Planted', color: '#2f7d45' },
    { value: 'Planned', color: '#b7791f' },
    { value: 'Flagged', color: '#c0392b' }
  ]
};
